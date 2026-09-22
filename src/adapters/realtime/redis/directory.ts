import type Redis from "ioredis";
import { directorySnapshot } from "../../../core/directory.js";
import type { DirectoryQueries } from "../../../core/ports.js";
import type { LocalSocket } from "../local/sockets.js";
import { liveChannel } from "./delivery.js";

/** Live directory for the self-hosted runtime: the snapshot is built from the
 *  selected persistent projections, the per-pool revision lives in Redis, and changes are
 *  broadcast on pub/sub for every instance to push to its own clients. */
export class RedisDirectoryService {
  private readonly clients = new Map<string, Set<LocalSocket>>();

  constructor(private readonly redis: Redis, private readonly queries: DirectoryQueries) {}

  private revisionKey(pool: string): string {
    return `live:rev:${pool}`;
  }

  async currentRevision(pool: string): Promise<number> {
    const value = await this.redis.get(this.revisionKey(pool));
    return value ? Number(value) : 0;
  }

  /** Registers a directory client and returns its initial snapshot. */
  async attach(pool: string, socket: LocalSocket): Promise<string> {
    let set = this.clients.get(pool);
    if (!set) { set = new Set(); this.clients.set(pool, set); }
    set.add(socket);
    return JSON.stringify(await directorySnapshot(this.queries, pool, await this.currentRevision(pool)));
  }

  detach(pool: string, socket: LocalSocket): void {
    const set = this.clients.get(pool);
    if (!set) return;
    set.delete(socket);
    if (!set.size) this.clients.delete(pool);
  }

  /** Mirrors the PoolDirectory's changed(): bumps the revision once globally,
   *  then pushes a fresh snapshot to all subscribers of the pool. */
  async publishChange(pool: string): Promise<void> {
    const revision = await this.redis.incr(this.revisionKey(pool));
    const snapshot = JSON.stringify(await directorySnapshot(this.queries, pool, revision));
    await this.redis.publish(liveChannel(pool), snapshot);
  }

  /** Pub/sub callback: delivers a published snapshot to local clients. */
  applyPublished(pool: string, snapshot: string): void {
    for (const socket of this.clients.get(pool) ?? []) {
      try { socket.send(snapshot); } catch { socket.close(1011, "Directory unavailable"); }
    }
  }
}
