import type Redis from "ioredis";
import type { RateLimitService } from "../../../core/ports.js";

const FIXED_WINDOW_LUA = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n`;

/** Fixed-window rate limit mirroring the RateGuard Durable Object: one counter
 *  per (client key, endpoint kind), window restarts on the first increment. */
export function createRedisRateLimit(redis: Redis): RateLimitService {
  return {
    async allow(key, kind, limit, windowMs) {
      const count = await redis.eval(FIXED_WINDOW_LUA, 1, `rl:${key}:${kind}`, String(windowMs)) as number;
      return count <= limit;
    },
  };
}
