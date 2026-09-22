import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createD1DataStores } from "../d1/index.js";
import { createD1RoomPersistence } from "../d1/room-persistence.js";
import type { SelfhostDataStores } from "../selfhost.js";
import type { PortableSqliteDatabase, PortableSqliteStatement } from "./protocol.js";

type SqlValue = string | number | bigint | null | Uint8Array;

class NodeSqliteStatement implements PortableSqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): PortableSqliteStatement {
    return new NodeSqliteStatement(this.database, this.sql, values as SqlValue[]);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.runSync().changes) } };
  }

  runSync(): { changes: number | bigint } {
    return this.database.prepare(this.sql).run(...this.values);
  }
}

/** Node implementation of the same prepared/batch surface used by D1. SQLite
 * batches use BEGIN IMMEDIATE so multi-statement RoomPersistence operations
 * remain atomic and fail before any partial projection is visible. */
export class NodeSqliteDatabase implements PortableSqliteDatabase {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  }

  prepare(sql: string): PortableSqliteStatement {
    return new NodeSqliteStatement(this.database, sql);
  }

  async batch(statements: PortableSqliteStatement[]): Promise<unknown[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof NodeSqliteStatement)) throw new Error("SQLite batch received a foreign statement");
        return { meta: { changes: Number(statement.runSync().changes) } };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (cause) {
      try { this.database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw cause;
    }
  }

  close(): void {
    this.database.close();
  }
}

export interface SqliteDataStores extends SelfhostDataStores {
  close(): void;
}

/** Reuses the D1/SQLite repository implementation and adds the shared room
 * persistence port. Only the database transport differs. */
export function createNodeSqliteDataStores(filename: string): SqliteDataStores {
  const database = new NodeSqliteDatabase(filename);
  return {
    ...createD1DataStores(database),
    roomPersistence: createD1RoomPersistence(database),
    close: () => database.close(),
  };
}
