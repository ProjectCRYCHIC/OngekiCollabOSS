import { directorySnapshot } from "../../../core/directory.js";
import { runCleanup } from "../../../core/cleanup.js";
import { coordinatorName } from "../../../core/pools.js";
import { RoomEngine } from "../../../core/rooms/engine.js";
import type { RoomDelivery } from "../../../core/rooms/delivery.js";
import type { MatchRequest } from "../../../core/protocol.js";
import type { PoolRealtimeService, RateLimitService, Reservation, Seat } from "../../../core/ports.js";
import type { RoomTicket } from "../../../core/tokens.js";
import type { SelfhostDataStores } from "../../database/selfhost.js";
import type { SelfhostDirectoryService, SelfhostRealtime, SelfhostRoomService } from "../selfhost.js";
import { LocalRoomRegistry, type LocalSocket } from "../local/sockets.js";
import { MemoryRoomStateRepository } from "./state.js";

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

class MemoryDirectoryService implements SelfhostDirectoryService {
  private readonly clients = new Map<string, Set<LocalSocket>>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly stores: SelfhostDataStores) {}

  async attach(pool: string, socket: LocalSocket): Promise<string> {
    let clients = this.clients.get(pool);
    if (!clients) { clients = new Set(); this.clients.set(pool, clients); }
    clients.add(socket);
    return JSON.stringify(await directorySnapshot(this.stores.directoryQueries, pool, this.revisions.get(pool) ?? 0));
  }

  detach(pool: string, socket: LocalSocket): void {
    const clients = this.clients.get(pool);
    if (!clients) return;
    clients.delete(socket);
    if (!clients.size) this.clients.delete(pool);
  }

  async publishChange(pool: string): Promise<void> {
    const revision = (this.revisions.get(pool) ?? 0) + 1;
    this.revisions.set(pool, revision);
    const snapshot = JSON.stringify(await directorySnapshot(this.stores.directoryQueries, pool, revision));
    for (const socket of this.clients.get(pool) ?? []) {
      try { socket.send(snapshot); } catch { socket.close(1011, "Directory unavailable"); }
    }
  }
}

class MemoryRoomDelivery implements RoomDelivery {
  constructor(private readonly roomId: string, private readonly registry: LocalRoomRegistry) {}

  broadcastText(text: string, exceptPeerId = 0): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId === exceptPeerId) continue;
      try { socket.send(text); } catch { /* close event reconciles membership */ }
    }
  }

  notifySpectators(text: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (!socket.data.spectator) continue;
      try { socket.send(text); } catch { /* close event reconciles membership */ }
    }
  }

  forwardFrame(data: Uint8Array, senderPeerId: number, targetPeerId: number | null): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId === senderPeerId) continue;
      if (targetPeerId !== null && socket.data.peerId !== targetPeerId) continue;
      try { socket.sendBinary(data); } catch { /* close event reconciles membership */ }
    }
  }

  closePeer(peerId: number, identityId: string, code: number, reason: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId === peerId && socket.data.identityId === identityId) socket.close(code, reason);
    }
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) socket.close(code, reason);
  }
}

class MemoryScheduler {
  private readonly alarms = new Map<string, NodeJS.Timeout>();
  private readonly retries = new Map<string, number>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly alarm: (roomId: string) => Promise<void>, private readonly stores: SelfhostDataStores) {}

  scheduleRoomAlarm(roomId: string, at: number): void {
    const old = this.alarms.get(roomId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => { void this.fire(roomId, timer); }, Math.max(0, at - Date.now()));
    timer.unref();
    this.alarms.set(roomId, timer);
  }

  private async fire(roomId: string, timer: NodeJS.Timeout): Promise<void> {
    if (this.alarms.get(roomId) === timer) this.alarms.delete(roomId);
    try {
      await this.alarm(roomId);
      this.retries.delete(roomId);
    } catch (cause) {
      console.warn("Scheduled job failed", cause instanceof Error ? cause.name : "unknown");
      const attempt = (this.retries.get(roomId) ?? 0) + 1;
      this.retries.set(roomId, attempt);
      this.scheduleRoomAlarm(roomId, Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(attempt, 6))));
    }
  }

  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void runCleanup(this.stores.cleanup, Date.now()).catch((cause) =>
        console.warn("Cleanup failed", cause instanceof Error ? cause.name : "unknown"));
    }, 60 * 60_000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const timer of this.alarms.values()) clearTimeout(timer);
    this.alarms.clear();
  }
}

class MemoryRoomService implements SelfhostRoomService {
  constructor(
    private readonly states: MemoryRoomStateRepository,
    private readonly stores: SelfhostDataStores,
    private readonly registry: LocalRoomRegistry,
    private readonly mutex: KeyedMutex,
    private readonly scheduler: MemoryScheduler,
    private readonly notifyDirectory: (pool: string) => void,
  ) {}

  private engine(roomId: string): RoomEngine {
    return new RoomEngine({
      state: this.states.state(roomId),
      persist: this.stores.roomPersistence,
      pools: { markOpen: async () => undefined, markClosed: async () => undefined },
      directory: { notify: this.notifyDirectory },
      registry: this.registry.view(roomId),
      delivery: new MemoryRoomDelivery(roomId, this.registry),
      scheduleAlarm: (at) => this.scheduler.scheduleRoomAlarm(roomId, at),
    });
  }

  private withRoom<T>(roomId: string, action: (engine: RoomEngine) => Promise<T>): Promise<T> {
    return this.mutex.run(`room:${roomId}`, async () => {
      try { return await action(this.engine(roomId)); }
      finally {
        const meta = await this.states.state(roomId).getMeta();
        if (!meta || meta.status === "closed") this.states.delete(roomId);
      }
    });
  }

  initializeRoom(roomId: string, coordinator: string, request: MatchRequest): Promise<void> {
    return this.withRoom(roomId, (engine) => engine.initialize({ id: roomId, coordinator, request }));
  }

  reserve(roomId: string, reservation: Reservation): Promise<Seat | null> {
    return this.withRoom(roomId, (engine) => engine.reserve(reservation));
  }

  validatePlayerConnection(roomId: string, payload: RoomTicket | null): Promise<Response | { ok: true }> {
    return this.withRoom(roomId, async (engine) => {
      const result = await engine.validatePlayerConnection(payload);
      return result instanceof Response ? result : { ok: true as const };
    });
  }

  async completePlayerConnection(roomId: string, socket: LocalSocket, payload: RoomTicket): Promise<void> {
    await this.withRoom(roomId, async (engine) => {
      const result = await engine.validatePlayerConnection(payload);
      if (result instanceof Response) { socket.close(1008, "Reservation unavailable"); return; }
      this.registry.add(roomId, socket);
      await engine.completePlayerConnection(socket, payload, result.meta);
    });
  }

  validateSpectator(roomId: string): Promise<Response | { ok: true }> {
    return this.withRoom(roomId, async (engine) => {
      const result = await engine.validateSpectator();
      return result instanceof Response ? result : { ok: true as const };
    });
  }

  async addSpectator(roomId: string, socket: LocalSocket): Promise<void> {
    await this.withRoom(roomId, async (engine) => {
      const result = await engine.validateSpectator();
      if (result instanceof Response) { socket.close(1013, "Room is busy"); return; }
      this.registry.add(roomId, socket);
      await engine.addSpectator(socket, result.meta);
    });
  }

  detach(roomId: string, socket: LocalSocket): void { this.registry.remove(roomId, socket); }

  onMessage(roomId: string, socket: LocalSocket, message: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (typeof message === "string") return this.withRoom(roomId, (engine) => engine.onMessage(socket, message));
    return this.engine(roomId).onMessage(socket, message);
  }

  onClose(roomId: string, socket: LocalSocket, reason: string): Promise<void> {
    return this.withRoom(roomId, async (engine) => {
      this.registry.remove(roomId, socket);
      await engine.onClose(socket, reason);
    });
  }

  async alarm(roomId: string): Promise<void> {
    await this.withRoom(roomId, async (engine) => { await engine.alarm(); });
  }

  banPlayer(roomId: string, identityId: string): Promise<boolean> {
    return this.withRoom(roomId, (engine) => engine.banPlayer(identityId));
  }

  forceClose(roomId: string): Promise<boolean> {
    return this.withRoom(roomId, (engine) => engine.forceClose());
  }
}

class MemoryPoolService implements PoolRealtimeService {
  constructor(private readonly rooms: MemoryRoomService, private readonly mutex: KeyedMutex) {}

  async create(request: MatchRequest, reservation: Reservation) {
    const coordinator = await coordinatorName(request.pool);
    return this.mutex.run(`pool:${coordinator}`, async () => {
      const roomId = crypto.randomUUID();
      try {
        await this.rooms.initializeRoom(roomId, coordinator, request);
        const seat = await this.rooms.reserve(roomId, reservation);
        if (!seat) throw new Error("Could not reserve new room");
        return { roomId, ...seat, status: "recruiting" };
      } catch (cause) {
        try { await this.rooms.forceClose(roomId); } catch { /* retain original failure */ }
        throw cause;
      }
    });
  }
}

const DEFAULT_MAX_RATE_LIMIT_KEYS = 10_000;

export function createMemoryRateLimit(options: { maxKeys?: number; now?: () => number } = {}): RateLimitService {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_RATE_LIMIT_KEYS;
  const nowValue = options.now ?? Date.now;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("maxKeys must be a positive integer");
  const windows = new Map<string, { count: number; expiresAt: number }>();
  let operations = 0;
  const cleanupExpired = (now: number): void => {
    for (const [name, window] of windows) {
      if (window.expiresAt <= now) windows.delete(name);
    }
  };
  return {
    async allow(key, kind, limit, windowMs) {
      const name = `${key}:${kind}`;
      const now = nowValue();
      operations += 1;
      if ((operations & 0xff) === 0) cleanupExpired(now);
      let window = windows.get(name);
      if (window?.expiresAt !== undefined && window.expiresAt <= now) {
        windows.delete(name);
        window = undefined;
      }
      if (!window) {
        if (windows.size >= maxKeys) cleanupExpired(now);
        if (windows.size >= maxKeys) return false;
        window = { count: 0, expiresAt: now + windowMs };
        windows.set(name, window);
      }
      window.count += 1;
      return window.count <= limit;
    },
  };
}

async function closeStalePersistentRooms(stores: SelfhostDataStores): Promise<void> {
  let beforeTime: number | null = null;
  let beforeId: string | null = null;
  for (;;) {
    const page = await stores.adminQueries.battleRows({ limit: 100, beforeTime, beforeId });
    for (const room of page.rows) await stores.roomPersistence.recoverExpiredRoom(room.id, "process_restarted", Date.now());
    const last = page.rows.at(-1);
    if (!page.hasMore || !last) return;
    beforeTime = last.updated_at;
    beforeId = last.id;
  }
}

/** In-memory realtime is a single-process deployment mode. Persistent active
 * projections from a previous process cannot have live sockets, so startup
 * closes them before accepting traffic. */
export function createMemoryRealtime(stores: SelfhostDataStores): SelfhostRealtime {
  const registry = new LocalRoomRegistry();
  const states = new MemoryRoomStateRepository();
  const mutex = new KeyedMutex();
  const directory = new MemoryDirectoryService(stores);
  const notify = (pool: string): void => {
    void directory.publishChange(pool).catch(() => console.warn("Directory push failed"));
  };
  let rooms!: MemoryRoomService;
  const scheduler = new MemoryScheduler((roomId) => rooms.alarm(roomId), stores);
  rooms = new MemoryRoomService(states, stores, registry, mutex, scheduler, notify);
  return {
    rooms,
    pools: new MemoryPoolService(rooms, mutex),
    rateLimit: createMemoryRateLimit(),
    directory,
    async start() {
      await closeStalePersistentRooms(stores);
      scheduler.start();
    },
    async health() { /* no external realtime dependency in memory mode */ },
    stop() { scheduler.stop(); },
  };
}
