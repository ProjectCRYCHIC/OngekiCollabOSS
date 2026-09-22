import type Redis from "ioredis";

const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Named critical section backed by Redis: SET NX PX with a random token and a
 *  compare-and-delete release. Crashed holders expire via the TTL. */
export async function withLock<T>(redis: Redis, key: string, ttlMs: number, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() >= deadline) throw new Error("Room coordination timed out");
    await sleep(25);
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => { /* expired naturally */ });
  }
}
