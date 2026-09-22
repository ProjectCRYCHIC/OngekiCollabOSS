// Explicit self-hosted admin password reset. The password hash and a fresh
// session generation are written to the selected persistent database. Redis
// sessions are also removed when enabled; memory sessions reject the changed
// generation on their next request.
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { hash as argon2Hash } from "@node-rs/argon2";

const password = process.env.ADMIN_NEW_PASSWORD || await (() => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question("New administrator password: ").finally(() => rl.close());
})();

if (!password || password.length < 8) {
  console.error("The administrator password must be at least 8 characters.");
  process.exit(1);
}

const databaseBackend = process.env.DATABASE_BACKEND || "mysql";
const realtimeBackend = process.env.REALTIME_BACKEND || "redis";
const now = Date.now();
const values = [
  ["admin_password_hash", await argon2Hash(password)],
  ["admin_session_generation", randomUUID()],
];

if (databaseBackend === "mysql") {
  const { createPool } = await import("mysql2/promise");
  const pool = createPool({
    host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "ongeki", password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "ongeki_collab", connectionLimit: 2,
  });
  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of values) await connection.query(
        "INSERT INTO service_settings(`key`,`value`,updated_at) VALUES(?,?,?) " +
        "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
        [key, value, now]);
      await connection.commit();
    } catch (cause) {
      await connection.rollback().catch(() => undefined);
      throw cause;
    } finally { connection.release(); }
  } finally { await pool.end(); }
} else if (databaseBackend === "sqlite") {
  const { DatabaseSync } = await import("node:sqlite");
  const filename = process.env.SQLITE_PATH || "data/ongeki-collab.sqlite";
  if (filename.trim() === ":memory:") throw new Error("SQLITE_PATH must point to a persistent file; :memory: is not supported");
  mkdirSync(dirname(resolve(filename)), { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    try {
      const statement = database.prepare("INSERT INTO service_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
      for (const [key, value] of values) statement.run(key, value, now);
      database.exec("COMMIT");
    } catch (cause) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw cause;
    }
  } finally { database.close(); }
} else throw new Error(`Unsupported DATABASE_BACKEND "${databaseBackend}"; expected mysql or sqlite`);

let revoked = 0;
if (realtimeBackend === "redis") {
  const Redis = (await import("ioredis")).default;
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  try {
    const ids = await redis.smembers("admin:sessions");
    revoked = ids.length;
    for (const id of ids) await redis.del(`admin:session:${id}`);
    if (ids.length) await redis.del("admin:sessions");
  } finally { await redis.quit().catch(() => redis.disconnect()); }
} else if (realtimeBackend !== "memory") {
  throw new Error(`Unsupported REALTIME_BACKEND "${realtimeBackend}"; expected redis or memory`);
}

console.log(`Administrator password updated; ${revoked} stored session(s) revoked.`);
