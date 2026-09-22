import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/runtimes/selfhost/config.js";

const secrets = {
  IDENTITY_HASH_SECRET: Buffer.alloc(32, 1).toString("base64"),
  KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 2).toString("base64"),
  TICKET_SIGNING_SECRET: Buffer.alloc(32, 3).toString("base64"),
};

describe("self-host storage configuration", () => {
  it("keeps mysql plus redis as the backward-compatible default", () => {
    expect(loadConfig(secrets)).toMatchObject({ databaseBackend: "mysql", realtimeBackend: "redis",
      db: { host: "127.0.0.1", port: 3306 }, redisUrl: "redis://127.0.0.1:6379" });
  });

  it("accepts persistent sqlite without a redis URL in memory mode", () => {
    expect(loadConfig({ ...secrets, DATABASE_BACKEND: "sqlite", REALTIME_BACKEND: "memory",
      SQLITE_PATH: "data/test.sqlite", REDIS_URL: "not-used" })).toMatchObject({
      databaseBackend: "sqlite", realtimeBackend: "memory", sqlitePath: "data/test.sqlite",
    });
  });

  it.each(["IDENTITY_HASH_SECRET", "KEY_ENCRYPTION_SECRET", "TICKET_SIGNING_SECRET"])(
    "requires %s to be canonical Base64 for exactly 32 bytes", (name) => {
      expect(() => loadConfig({ ...secrets, [name]: "replace-with-32-byte-base64" })).toThrow(name);
    });

  it("rejects process-local SQLite because migration and runtime use separate processes", () => {
    expect(() => loadConfig({ ...secrets, DATABASE_BACKEND: "sqlite", REALTIME_BACKEND: "memory",
      SQLITE_PATH: ":memory:" })).toThrow("persistent");
  });

  it.each([
    [{ ...secrets, DATABASE_BACKEND: "postgres" }, "DATABASE_BACKEND"],
    [{ ...secrets, REALTIME_BACKEND: "disk" }, "REALTIME_BACKEND"],
    [{ ...secrets, PORT: "0" }, "PORT"],
    [{ ...secrets, TRUST_PROXY: "yes" }, "TRUST_PROXY"],
    [{ ...secrets, REDIS_URL: "http://cache" }, "REDIS_URL"],
  ])("rejects invalid configuration", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
