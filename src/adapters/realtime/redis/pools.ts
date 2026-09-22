import type Redis from "ioredis";
import { withLock } from "./locks.js";
import type { RedisRoomService } from "./room-service.js";
import type { MatchRequest } from "../../../core/protocol.js";
import type { PoolRealtimeService, Reservation } from "../../../core/ports.js";
import { coordinatorName } from "../../../core/pools.js";

const POOL_LOCK_TTL_MS = 10_000;
const POOL_LOCK_TIMEOUT_MS = 15_000;

/** Pool creation serialized per pool by a Redis lock — the counterpart of the
 *  PoolCoordinator Durable Object's promise queue. */
export class RedisPoolService implements PoolRealtimeService {
  constructor(private readonly redis: Redis, private readonly rooms: RedisRoomService) {}

  async create(request: MatchRequest, reservation: Reservation): Promise<{ roomId: string; peerId: number; reservationId: string; status: string }> {
    const name = await coordinatorName(request.pool);
    return withLock(this.redis, `pool:${name}:lock`, POOL_LOCK_TTL_MS, POOL_LOCK_TIMEOUT_MS, async () => {
      const roomId = crypto.randomUUID();
      try {
        await this.rooms.initializeRoom(roomId, name, request);
        const seat = await this.rooms.reserve(roomId, reservation);
        if (!seat) throw new Error("Could not reserve new room");
        return { roomId, peerId: seat.peerId, reservationId: seat.reservationId, status: "recruiting" };
      } catch (cause) {
        try { await this.rooms.forceClose(roomId); } catch { /* keep the original creation failure */ }
        throw cause;
      }
    });
  }
}
