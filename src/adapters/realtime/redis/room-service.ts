import type Redis from "ioredis";
import { RoomEngine } from "../../../core/rooms/engine.js";
import type { RoomDelivery } from "../../../core/rooms/delivery.js";
import type { RoomPersistence } from "../../../core/rooms/persistence.js";
import type { RoomSetup } from "../../../core/rooms/types.js";
import { createRedisRoomState } from "./state.js";
import { withLock } from "./locks.js";
import { RedisRoomDelivery } from "./delivery.js";
import type { LocalRoomRegistry, LocalSocket } from "../local/sockets.js";
import type { RedisScheduler } from "./scheduler.js";
import type { Reservation, RoomRealtimeService, Seat } from "../../../core/ports.js";
import type { RoomTicket } from "../../../core/tokens.js";
import type { MatchRequest } from "../../../core/protocol.js";

const ROOM_LOCK_TTL_MS = 5_000;
const ROOM_LOCK_TIMEOUT_MS = 8_000;

/** Self-hosted room coordination: the shared RoomEngine runs against Redis
 *  state, with every state mutation serialized by a per-room lock — the
 *  equivalent of the Durable Object's single-threaded event loop. */
export class RedisRoomService implements RoomRealtimeService {
  constructor(
    private readonly redis: Redis,
    private readonly persist: RoomPersistence,
    private readonly registry: LocalRoomRegistry,
    private readonly publisher: Redis,
    private readonly scheduler: RedisScheduler,
    private readonly notifyDirectory: (pool: string) => void,
  ) {}

  private engine(roomId: string): RoomEngine {
    return new RoomEngine({
      state: createRedisRoomState(this.redis, roomId),
      persist: this.persist,
      pools: {
        // The persistent rooms table already carries room status; pool bookkeeping
        // beyond the create lock has no dedicated coordinator to update.
        markOpen: async () => undefined,
        markClosed: async () => undefined,
      },
      directory: { notify: (pool) => this.notifyDirectory(pool) },
      registry: this.registry.view(roomId),
      delivery: this.delivery(roomId),
      scheduleAlarm: (at) => this.scheduler.scheduleRoomAlarm(roomId, at),
    });
  }

  private delivery(roomId: string): RoomDelivery {
    return new RedisRoomDelivery(roomId, this.registry, this.publisher);
  }

  private async withRoom<T>(roomId: string, fn: (engine: RoomEngine) => Promise<T>): Promise<T> {
    return withLock(this.redis, `room:${roomId}:lock`, ROOM_LOCK_TTL_MS, ROOM_LOCK_TIMEOUT_MS, () => fn(this.engine(roomId)));
  }

  initializeRoom(roomId: string, coordinator: string, request: MatchRequest): Promise<void> {
    return this.withRoom(roomId, (engine) => engine.initialize({ id: roomId, coordinator, request }));
  }

  async reserve(roomId: string, reservation: Reservation): Promise<Seat | null> {
    return this.withRoom(roomId, (engine) => engine.reserve(reservation));
  }

  /** Upgrade-phase validation (ticket already verified by the runtime). */
  validatePlayerConnection(roomId: string, payload: RoomTicket | null): Promise<Response | { ok: true }> {
    return this.withRoom(roomId, async (engine) => {
      const outcome = await engine.validatePlayerConnection(payload);
      return outcome instanceof Response ? outcome : { ok: true as const };
    });
  }

  /** Post-acceptance: re-validates under the lock (the reservation may have been
   *  revoked while the handshake was in flight) and completes the join. */
  async completePlayerConnection(roomId: string, socket: LocalSocket, payload: RoomTicket): Promise<void> {
    await this.withRoom(roomId, async (engine) => {
      const outcome = await engine.validatePlayerConnection(payload);
      if (outcome instanceof Response) {
        socket.close(1008, "Reservation unavailable");
        return;
      }
      this.registry.add(roomId, socket);
      await engine.completePlayerConnection(socket, payload, outcome.meta);
    });
  }

  validateSpectator(roomId: string): Promise<Response | { ok: true }> {
    return this.withRoom(roomId, async (engine) => {
      const outcome = await engine.validateSpectator();
      return outcome instanceof Response ? outcome : { ok: true as const };
    });
  }

  async addSpectator(roomId: string, socket: LocalSocket): Promise<void> {
    await this.withRoom(roomId, async (engine) => {
      const outcome = await engine.validateSpectator();
      if (outcome instanceof Response) {
        socket.close(1013, "Room is busy");
        return;
      }
      this.registry.add(roomId, socket);
      await engine.addSpectator(socket, outcome.meta);
    });
  }

  detach(roomId: string, socket: LocalSocket): void {
    this.registry.remove(roomId, socket);
  }

  /** Control messages mutate room state and take the lock; binary frames only
   *  read state and mirror fan-out, matching the relay fast path. */
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

  alarm(roomId: string): Promise<void> {
    return this.withRoom(roomId, async (engine) => {
      if (await engine.alarm()) return;
      const pool = await this.persist.recoverExpiredRoom(roomId, "live_state_expired", Date.now());
      if (pool !== null) this.notifyDirectory(pool);
    });
  }

  banPlayer(roomId: string, identityId: string): Promise<boolean> {
    return this.withRoom(roomId, (engine) => engine.banPlayer(identityId));
  }

  forceClose(roomId: string): Promise<boolean> {
    return this.withRoom(roomId, (engine) => engine.forceClose());
  }
}
