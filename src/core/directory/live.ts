import { directorySnapshot } from "../directory.js";
import type { DirectoryQueries } from "../ports.js";

export interface DirectoryClient {
  send(message: string): unknown;
  close(code: number, reason: string): unknown;
}

/** Revision source for the live directory: monotonic per pool. */
export interface DirectoryRevisionStore {
  current(): Promise<number>;
  next(): Promise<number>;
}

/** Deployment-agnostic live directory engine: builds public snapshots from the
 *  persistent queries and pushes them to read-only WebSocket clients. */
export class LiveDirectoryEngine {
  constructor(private readonly queries: DirectoryQueries, private readonly revisions: DirectoryRevisionStore) {}

  /** Snapshot pushed once when a directory client connects (current revision). */
  async connectPayload(pool: string): Promise<string> {
    return JSON.stringify(await directorySnapshot(this.queries, pool, await this.revisions.current()));
  }

  /** Bumps the revision and pushes a fresh snapshot to the given clients,
   *  dropping those that fail to receive. Throws when the snapshot cannot be
   *  built; callers close their clients in that case. */
  async announce(pool: string, clients: readonly DirectoryClient[]): Promise<void> {
    const revision = await this.revisions.next();
    if (!clients.length) return;
    try {
      const snapshot = JSON.stringify(await directorySnapshot(this.queries, pool, revision));
      for (const client of clients) {
        try { client.send(snapshot); } catch { client.close(1011, "Directory unavailable"); }
      }
    } catch (cause) {
      for (const client of clients) client.close(1011, "Directory unavailable");
      throw cause;
    }
  }
}
