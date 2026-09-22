import { hash as argon2Hash } from "@node-rs/argon2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryPasswordSessionStore } from "../src/adapters/auth/memory-sessions.js";
import { PasswordSessionAuthenticator } from "../src/adapters/auth/password.js";
import { createMemoryRateLimit } from "../src/adapters/realtime/memory/index.js";
import type { SettingsRepository } from "../src/core/ports.js";
import { startServer } from "../src/runtimes/selfhost/server.js";

describe("self-host runtime safety", () => {
  it("does not let an old password inherit a concurrently reset session generation", async () => {
    const values = new Map<string, { value: string; updatedAt: number | null }>([
      ["admin_password_hash", { value: await argon2Hash("old-password"), updatedAt: 1 }],
      ["admin_session_generation", { value: "old-generation", updatedAt: 1 }],
    ]);
    let resetScheduled = false;
    const settings: SettingsRepository = {
      async getIdentityRequired() { return { required: false, updatedAt: null }; },
      async setIdentityRequired() { /* unused */ },
      async getValue(key) {
        const snapshot = values.get(key);
        if (key === "admin_password_hash" && !resetScheduled) {
          resetScheduled = true;
          queueMicrotask(() => {
            values.set("admin_password_hash", { value: "new-password-hash", updatedAt: 2 });
            values.set("admin_session_generation", { value: "new-generation", updatedAt: 2 });
          });
        }
        return snapshot ? { ...snapshot } : null;
      },
      async setValue(key, value, now) { values.set(key, { value, updatedAt: now }); },
    };
    const sessions = new MemoryPasswordSessionStore();
    const authenticator = new PasswordSessionAuthenticator(sessions, settings);
    const response = await authenticator.login(new Request("http://localhost/admin/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "old-password" }),
    }));

    expect(response.status).toBe(401);
    expect(await sessions.smembers("admin:sessions")).toEqual([]);
  });

  it("cleans expired memory sessions and enforces a hard capacity", async () => {
    let now = 0;
    const sessions = new MemoryPasswordSessionStore(1, () => now);
    await sessions.set("admin:session:first", "{}", "EX", 1);
    await sessions.sadd("admin:sessions", "first");
    await expect(sessions.set("admin:session:second", "{}", "EX", 1)).rejects.toThrow("capacity");

    now = 1001;
    expect(await sessions.smembers("admin:sessions")).toEqual([]);
    await expect(sessions.set("admin:session:second", "{}", "EX", 1)).resolves.toBe("OK");
  });

  it("bounds memory rate-limit keys and reclaims expired windows", async () => {
    let now = 0;
    const rateLimit = createMemoryRateLimit({ maxKeys: 2, now: () => now });
    expect(await rateLimit.allow("one", "match", 10, 1000)).toBe(true);
    expect(await rateLimit.allow("two", "match", 10, 1000)).toBe(true);
    expect(await rateLimit.allow("three", "match", 10, 1000)).toBe(false);

    now = 1001;
    expect(await rateLimit.allow("three", "match", 10, 1000)).toBe(true);
  });

  it("fails startup when the configured Redis endpoint is unreachable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ongeki-collab-redis-failure-"));
    const secret = Buffer.alloc(32, 7).toString("base64");
    try {
      await expect(startServer({
        DATABASE_BACKEND: "sqlite", REALTIME_BACKEND: "redis",
        SQLITE_PATH: join(directory, "test.sqlite"), REDIS_URL: "redis://127.0.0.1:1",
        PORT: "65431", IDENTITY_HASH_SECRET: secret, KEY_ENCRYPTION_SECRET: secret,
        TICKET_SIGNING_SECRET: secret,
      })).rejects.toBeInstanceOf(Error);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
