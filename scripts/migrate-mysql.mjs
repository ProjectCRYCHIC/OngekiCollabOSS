// Applies migrations/mysql/*.sql to the self-hosted MySQL/MariaDB database.
// Safe to run concurrently and on every container start: a named lock
// (GET_LOCK) serializes runners and the schema_migrations ledger skips
// already-applied files. Configuration comes from the DB_* environment
// variables documented in .env.example.
import { createPool } from "mysql2/promise";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "mysql");
const LOCK_NAME = "ongeki_collab_migrate";

const password = process.env.DB_PASSWORD ?? "";
const pool = createPool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "ongeki",
  password,
  database: process.env.DB_NAME ?? "ongeki_collab",
  multipleStatements: true,
  connectionLimit: 2,
});

try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const conn = await pool.getConnection();
  try {
    const [[{ acquired }]] = await conn.query("SELECT GET_LOCK(?, 60) AS acquired", [LOCK_NAME]);
    if (acquired !== 1) throw new Error("Could not acquire the migration lock; another runner may be stuck");
    try {
      const [rows] = await conn.query("SELECT name FROM schema_migrations");
      const applied = new Set(rows.map((row) => row.name));
      const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        process.stdout.write(`Applying ${file} ... `);
        await conn.query(readFileSync(join(migrationsDir, file), "utf8"));
        await conn.query("INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)", [file, Date.now()]);
        console.log("done");
      }
      console.log("Migrations up to date");
    } finally {
      await conn.query("DO RELEASE_LOCK(?)", [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
} finally {
  await pool.end();
}
