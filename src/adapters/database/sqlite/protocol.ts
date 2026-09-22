/** Small async SQLite surface shared by Cloudflare D1 and Node's built-in
 * SQLite driver. Keeping SQL repositories behind this shape prevents a second
 * copy of the persistence business rules. */
export interface PortableSqliteStatement {
  bind(...values: unknown[]): PortableSqliteStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface PortableSqliteDatabase {
  prepare(sql: string): PortableSqliteStatement;
  batch(statements: PortableSqliteStatement[]): Promise<unknown[]>;
}
