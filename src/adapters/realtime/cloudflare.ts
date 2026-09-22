import type { Env } from "../../types.js";
import type { PoolRealtimeService, RateLimitService, RoomRealtimeService, SongCatalog, SongCatalogCache } from "../../core/ports.js";
import { coordinatorName } from "../../core/pools.js";

export function createRoomRealtime(env: Env): RoomRealtimeService {
  return {
    reserve: (roomId, reservation) => env.ROOMS.getByName(roomId).reserve(reservation),
    banPlayer: (roomId, identityId) => env.ROOMS.getByName(roomId).banPlayer(identityId),
    forceClose: (roomId) => env.ROOMS.getByName(roomId).forceClose(),
  };
}

export function createPoolRealtime(env: Env): PoolRealtimeService {
  return {
    async create(request, reservation) {
      return env.POOLS.getByName(await coordinatorName(request.pool)).create(request, reservation);
    },
  };
}

export function createRateLimit(env: Env): RateLimitService {
  return {
    allow: (key, kind, limit, windowMs) => env.GUARDS.getByName(key).allow(kind, limit, windowMs),
  };
}

/** Edge cache implementation of the song catalog cache via the Cache API. */
export function createCatalogCache(): SongCatalogCache {
  const CACHE_URL = "https://cache.internal/api/v1/songs/v1";
  const cache = (caches as unknown as { default: Cache }).default;
  return {
    async get(): Promise<SongCatalog | null> {
      const cached = await cache.match(CACHE_URL);
      return cached ? await cached.json() as SongCatalog : null;
    },
    async set(catalog: SongCatalog) {
      await cache.put(CACHE_URL, new Response(JSON.stringify(catalog), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${24 * 60 * 60}` },
      }));
    },
  };
}
