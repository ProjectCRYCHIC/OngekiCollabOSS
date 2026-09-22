import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../../types.js";
import { MatchRequest, parsePool } from "../../../core/protocol.js";
import { verifyToken } from "../../../core/crypto.js";
import type { RoomTicket } from "../../../core/tokens.js";
import type { Seat } from "../../../core/ports.js";
import { createD1DataStores } from "../../database/d1/index.js";
import { createD1RoomPersistence } from "../../database/d1/room-persistence.js";
import { createSqliteRoomState } from "./state-sqlite.js";
import { HibernationDelivery, HibernationRegistry } from "./sockets.js";
import { RoomEngine } from "../../../core/rooms/engine.js";
import type { Reservation, RoomEngineDeps } from "../../../core/rooms/engine.js";
import type { RoomSetup } from "../../../core/rooms/types.js";
import { LiveDirectoryEngine } from "../../../core/directory/live.js";

function error(message: string, status = 400): Response { return Response.json({ error: message }, { status }); }

export class RateGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS windows (kind TEXT PRIMARY KEY, start_at INTEGER NOT NULL, count INTEGER NOT NULL)");
  }

  allow(kind: string, limit: number, durationMs: number): boolean {
    const now = Date.now();
    const row = (this.ctx.storage.sql.exec("SELECT start_at,count FROM windows WHERE kind = ?", kind).toArray() as unknown as Array<{start_at:number;count:number}>)[0];
    if (!row || now - row.start_at >= durationMs) {
      this.ctx.storage.sql.exec("INSERT INTO windows(kind,start_at,count) VALUES(?,?,1) ON CONFLICT(kind) DO UPDATE SET start_at=excluded.start_at,count=1", kind, now);
      return true;
    }
    if (row.count >= limit) return false;
    this.ctx.storage.sql.exec("UPDATE windows SET count = count + 1 WHERE kind = ?", kind);
    return true;
  }
}

/** One public, read-only WebSocket directory per exact matching pool. */
export class PoolDirectory extends DurableObject<Env> {
  private readonly engine: LiveDirectoryEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS live_version (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO live_version(id,revision) VALUES(1,0)");
    const revision = (): number =>
      ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM live_version WHERE id = 1").one().revision;
    this.engine = new LiveDirectoryEngine(createD1DataStores(env.DB).directoryQueries, {
      current: async () => revision(),
      next: async () => ctx.storage.sql.exec<{ revision: number }>(
        "UPDATE live_version SET revision = revision + 1 WHERE id = 1 RETURNING revision").one().revision,
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error("WebSocket required", 426);
    const pool = parsePool(new URL(request.url).searchParams.get("pool")) ?? "";
    if (this.ctx.getWebSockets().length >= 1000) return error("Directory is busy", 503);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ pool });
    this.ctx.acceptWebSocket(server);
    try {
      server.send(await this.engine.connectPayload(pool));
    } catch (cause) {
      server.close(1011, "Directory unavailable");
      throw cause;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async changed(pool: string): Promise<void> {
    const clients = this.ctx.getWebSockets()
      .filter((socket) => (socket.deserializeAttachment() as { pool?: string } | null)?.pool === pool)
      .map((socket) => ({
        send: (message: string) => socket.send(message),
        close: (code: number, reason: string) => socket.close(code, reason),
      }));
    await this.engine.announce(pool, clients);
  }

  webSocketMessage(socket: WebSocket): void { socket.close(1008, "Read-only directory"); }
}

export class PoolCoordinator extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pool_rooms (id TEXT PRIMARY KEY, match_key TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
  }

  /** Rooms are strictly isolated: a recruit without roomId always creates a brand-new room. */
  async create(request: MatchRequest, reservation: Reservation): Promise<{ roomId: string; peerId: number; reservationId: string; status: string }> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.queue;
    this.queue = next;
    await previous;
    try {
      const roomId = crypto.randomUUID();
      const room = this.env.ROOMS.getByName(roomId);
      try {
        await room.initialize({ id: roomId, coordinator: this.ctx.id.toString(), request });
        const seat = await room.reserve(reservation);
        if (seat === null) throw new Error("Could not reserve new room");
        this.ctx.storage.sql.exec("INSERT INTO pool_rooms(id,match_key,created_at) VALUES(?,?,?)", roomId, request.pool ?? "", Date.now());
        return { roomId, ...seat, status: "recruiting" };
      } catch (cause) {
        try { await room.forceClose(); } catch { /* keep the original creation failure */ }
        throw cause;
      }
    } finally { release(); }
  }

  markClosed(roomId: string): void {
    this.ctx.storage.sql.exec("UPDATE pool_rooms SET closed = 1 WHERE id = ?", roomId);
  }

  markOpen(roomId: string): void {
    this.ctx.storage.sql.exec("UPDATE pool_rooms SET closed = 0 WHERE id = ?", roomId);
  }
}

/** Durable Object shell: hibernation WebSockets plus storage bindings around
 *  the shared RoomEngine state machine. */
export class RelayRoom extends DurableObject<Env> {
  private readonly engine: RoomEngine;
  private readonly registry: HibernationRegistry;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.registry = new HibernationRegistry(ctx);
    const deps: RoomEngineDeps = {
      state: createSqliteRoomState(ctx),
      persist: createD1RoomPersistence(env.DB),
      pools: {
        markOpen: (coordinator, roomId) => env.POOLS.get(env.POOLS.idFromString(coordinator)).markOpen(roomId),
        markClosed: (coordinator, roomId) => env.POOLS.get(env.POOLS.idFromString(coordinator)).markClosed(roomId),
      },
      directory: {
        notify: (pool) => ctx.waitUntil(env.DIRECTORIES.getByName(`live:${pool}`).changed(pool)
          .catch(() => { console.warn("Directory push failed"); })),
      },
      registry: this.registry,
      delivery: new HibernationDelivery(this.registry),
      scheduleAlarm: (at) => ctx.storage.setAlarm(at),
    };
    this.engine = new RoomEngine(deps);
  }

  initialize(setup: RoomSetup): Promise<void> { return this.engine.initialize(setup); }
  reserve(reservation: Reservation): Promise<Seat | null> { return this.engine.reserve(reservation); }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("WebSocket required", 426);
    if (request.headers.get("X-Spectator") === "1") return this.spectate();
    const ticket = request.headers.get("X-Room-Ticket");
    const payload = ticket ? await verifyToken<RoomTicket>(this.env.TICKET_SIGNING_SECRET, ticket, "room") : null;
    const validated = await this.engine.validatePlayerConnection(payload);
    if (validated instanceof Response) return validated;
    const pair = new WebSocketPair();
    const wrapped = this.registry.attach(pair[1], { peerId: payload!.peerId, identityId: payload!.identityId, messages: 0, windowStart: Date.now() });
    this.ctx.acceptWebSocket(pair[1]);
    await this.engine.completePlayerConnection(wrapped, payload!, validated.meta);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async spectate(): Promise<Response> {
    const validated = await this.engine.validateSpectator();
    if (validated instanceof Response) return validated;
    const pair = new WebSocketPair();
    const wrapped = this.registry.attach(pair[1], { peerId: 0, identityId: "", messages: 0, windowStart: Date.now(), spectator: true });
    this.ctx.acceptWebSocket(pair[1]);
    await this.engine.addSpectator(wrapped, validated.meta);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const wrapped = this.registry.resolve(socket);
    if (!wrapped) { socket.close(1008, "No member"); return; }
    await this.engine.onMessage(wrapped, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const wrapped = this.registry.resolve(socket);
    if (wrapped) await this.engine.onClose(wrapped, "disconnect");
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const wrapped = this.registry.resolve(socket);
    if (wrapped) await this.engine.onClose(wrapped, "socket_error");
  }

  forceClose(): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(() => this.engine.forceClose());
  }

  banPlayer(identityId: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(() => this.engine.banPlayer(identityId));
  }

  async alarm(): Promise<void> { await this.engine.alarm(); }
}
