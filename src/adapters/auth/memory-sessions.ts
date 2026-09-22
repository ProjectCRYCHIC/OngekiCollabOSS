import type { PasswordSessionStore } from "./password.js";

interface Value { value: string; expiresAt: number }

const SESSION_KEY_PREFIX = "admin:session:";
const SESSION_INDEX_KEY = "admin:sessions";
const DEFAULT_MAX_SESSIONS = 4096;

/** Ephemeral admin sessions used when Redis is disabled. Password hashes and
 * the session generation remain in the selected persistent database. */
export class MemoryPasswordSessionStore implements PasswordSessionStore {
  private readonly values = new Map<string, Value>();
  private readonly sets = new Map<string, Set<string>>();

  constructor(
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("maxSessions must be a positive integer");
  }

  private removeValue(key: string): boolean {
    const removed = this.values.delete(key);
    if (key.startsWith(SESSION_KEY_PREFIX)) {
      const sessions = this.sets.get(SESSION_INDEX_KEY);
      sessions?.delete(key.slice(SESSION_KEY_PREFIX.length));
      if (sessions?.size === 0) this.sets.delete(SESSION_INDEX_KEY);
    }
    return removed;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [key, value] of this.values) {
      if (value.expiresAt <= now) this.removeValue(key);
    }
  }

  async set(key: string, value: string, _mode: "EX", ttl: number): Promise<unknown> {
    this.cleanupExpired();
    if (!this.values.has(key) && this.values.size >= this.maxSessions) {
      throw new Error("In-memory admin session capacity exceeded");
    }
    this.values.set(key, { value, expiresAt: this.now() + ttl * 1000 });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const value = this.values.get(key);
    if (!value || value.expiresAt <= this.now()) {
      this.removeValue(key);
      return null;
    }
    return value.value;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const value = await this.get(key);
    if (value === null) return 0;
    this.values.set(key, { value, expiresAt: this.now() + seconds * 1000 });
    return 1;
  }

  async del(key: string): Promise<unknown> {
    const removed = this.removeValue(key);
    this.sets.delete(key);
    return removed ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<unknown> {
    this.cleanupExpired();
    let values = this.sets.get(key);
    if (!values) { values = new Set(); this.sets.set(key, values); }
    const before = values.size;
    values.add(member);
    return values.size === before ? 0 : 1;
  }

  async srem(key: string, member: string): Promise<unknown> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    this.cleanupExpired();
    return [...(this.sets.get(key) ?? [])];
  }
}
