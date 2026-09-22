import type Redis from "ioredis";
import type { SelfhostDataStores } from "../../database/selfhost.js";
import type { PoolRealtimeService, RateLimitService, RoomRealtimeService } from "../../../core/ports.js";
import type { SelfhostRealtime } from "../selfhost.js";
import { RedisDirectoryService } from "./directory.js";
import { applyRoomBusMessage, INSTANCE_ID, liveChannel, roomChannel } from "./delivery.js";
import type { RoomBusMessage } from "./delivery.js";
import { RedisPoolService } from "./pools.js";
import { RedisRoomService } from "./room-service.js";
import { createRedisRateLimit } from "./rate-limit.js";
import { LocalRoomRegistry } from "./sockets.js";
import { RedisScheduler } from "./scheduler.js";

export interface RedisRealtime extends SelfhostRealtime {
  rooms: RedisRoomService;
  pools: PoolRealtimeService;
  rateLimit: RateLimitService;
  directory: RedisDirectoryService;
  scheduler: RedisScheduler;
  registry: LocalRoomRegistry;
  /** Starts the pub/sub subscriber and the scheduler timers. */
  start(): Promise<void>;
  /** Verifies every Redis connection used by the realtime stack. */
  health(): Promise<void>;
  /** Stops background timers; connections stay open for graceful teardown. */
  stop(): void;
}

/** Assembles the self-hosted realtime stack.
 *
 *  Connection roles: `db` runs state/lock commands, `publisher` runs pub/sub
 *  publishes and Lua jobs, `subscriber` is dedicated to receiving bus messages
 *  (a subscribed Redis connection cannot run regular commands). */
export function createRedisRealtime(db: Redis, publisher: Redis, subscriber: Redis, stores: SelfhostDataStores): RedisRealtime {
  const registry = new LocalRoomRegistry();
  const directory = new RedisDirectoryService(publisher, stores.directoryQueries);

  const notifyDirectory = (pool: string): void => {
    directory.publishChange(pool).catch(() => { console.warn("Directory push failed"); });
  };

  let roomsRef: RedisRoomService | undefined;
  const scheduler = new RedisScheduler(db, async (roomId) => roomsRef!.alarm(roomId), stores.cleanup);
  const rooms = new RedisRoomService(db, stores.roomPersistence, registry, publisher, scheduler, notifyDirectory);
  roomsRef = rooms;
  const pools = new RedisPoolService(db, rooms);
  const rateLimit = createRedisRateLimit(db);

  let started = false;
  let startPromise: Promise<void> | null = null;
  const onPublished = (_pattern: string, channel: string, payload: string): void => {
    if (channel.startsWith("bus:room:")) {
      try { applyRoomBusMessage(registry, JSON.parse(payload) as RoomBusMessage, INSTANCE_ID); }
      catch { console.warn("Room bus message dropped"); }
      return;
    }
    directory.applyPublished(channel.slice("bus:live:".length), payload);
  };
  return {
    rooms,
    pools,
    rateLimit,
    directory,
    scheduler,
    registry,
    start() {
      if (startPromise) return startPromise;
      subscriber.on("pmessage", onPublished);
      startPromise = Promise.all([
        db.ping(),
        publisher.ping(),
        subscriber.psubscribe(roomChannel("*"), liveChannel("*")),
      ]).then(() => {
        scheduler.start();
        started = true;
      }).catch((cause) => {
        subscriber.off("pmessage", onPublished);
        startPromise = null;
        throw cause;
      });
      return startPromise;
    },
    async health() {
      if (!started) throw new Error("Redis realtime is not ready");
      await Promise.all([db.ping(), publisher.ping(), subscriber.ping()]);
    },
    stop() {
      scheduler.stop();
      subscriber.off("pmessage", onPublished);
      started = false;
    },
  };
}
