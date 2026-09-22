// Applies the D1-compatible SQLite migrations to a persistent Node SQLite file.
// BEGIN IMMEDIATE serializes concurrent container starts; schema_migrations
// makes every subsequent start idempotent.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const filename = process.env.SQLITE_PATH || "data/ongeki-collab.sqlite";
if (filename.trim() === ":memory:") throw new Error("SQLITE_PATH must point to a persistent file; :memory: is not supported");
mkdirSync(dirname(resolve(filename)), { recursive: true });
const database = new DatabaseSync(filename);
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 60000; PRAGMA journal_mode = WAL;");

try {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  database.exec("BEGIN IMMEDIATE");
  try {
    const applied = new Set(database.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name));
    const files = readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      process.stdout.write(`Applying ${file} ... `);
      database.exec(readFileSync(join(migrationsDir, file), "utf8"));
      database.prepare("INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)").run(file, Date.now());
      console.log("done");
    }
    database.exec("COMMIT");
    console.log("Migrations up to date");
  } catch (cause) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
    throw cause;
  }
} finally {
  database.close();
}
