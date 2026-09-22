import type { PoolCoordinator, PoolDirectory, RateGuard, RelayRoom } from "./adapters/realtime/durable-objects/index.js";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  POOLS: DurableObjectNamespace<PoolCoordinator>;
  ROOMS: DurableObjectNamespace<RelayRoom>;
  GUARDS: DurableObjectNamespace<RateGuard>;
  DIRECTORIES: DurableObjectNamespace<PoolDirectory>;
  IDENTITY_HASH_SECRET: string;
  KEY_ENCRYPTION_SECRET: string;
  TICKET_SIGNING_SECRET: string;
  ADMIN_RESET_SECRET: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}
