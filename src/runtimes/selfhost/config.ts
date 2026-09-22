import type { AppSecrets } from "../../core/ports.js";

export interface SelfhostConfig {
  port: number;
  trustProxy: boolean;
  webRoot: string;
  databaseBackend: "mysql" | "sqlite";
  realtimeBackend: "redis" | "memory";
  db: { host: string; port: number; user: string; password: string; database: string };
  sqlitePath: string;
  redisUrl: string;
  secrets: AppSecrets;
  adminInitialPassword?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function secret32(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${name} must be canonical Base64 for exactly 32 bytes`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical Base64 for exactly 32 bytes`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function choice<const T extends readonly string[]>(env: NodeJS.ProcessEnv, name: string, fallback: T[number], allowed: T): T[number] {
  const value = optional(env, name, fallback);
  if (!allowed.includes(value)) throw new Error(`Unsupported ${name} "${value}"; expected ${allowed.join(" or ")}`);
  return value as T[number];
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: string): number {
  const value = Number(optional(env, name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
}

/** Fails closed: missing secrets or an unknown auth mode abort the boot instead
 *  of degrading any authenticated surface. */
export function loadConfig(env: NodeJS.ProcessEnv): SelfhostConfig {
  const authMode = optional(env, "ADMIN_AUTH_MODE", "password");
  if (authMode !== "password") throw new Error(`Unsupported ADMIN_AUTH_MODE "${authMode}"; self-hosted builds only support password admin auth`);
  const deploymentMode = optional(env, "DEPLOYMENT_MODE", "selfhost");
  if (deploymentMode !== "selfhost") throw new Error(`Unsupported DEPLOYMENT_MODE "${deploymentMode}" for the self-hosted runtime`);
  const trustProxy = optional(env, "TRUST_PROXY", "0");
  if (trustProxy !== "0" && trustProxy !== "1") throw new Error("TRUST_PROXY must be 0 or 1");
  const databaseBackend = choice(env, "DATABASE_BACKEND", "mysql", ["mysql", "sqlite"] as const);
  const realtimeBackend = choice(env, "REALTIME_BACKEND", "redis", ["redis", "memory"] as const);
  const sqlitePath = optional(env, "SQLITE_PATH", "data/ongeki-collab.sqlite");
  if (databaseBackend === "sqlite" && !sqlitePath.trim()) throw new Error("SQLITE_PATH is required for DATABASE_BACKEND=sqlite");
  if (databaseBackend === "sqlite" && sqlitePath.trim() === ":memory:")
    throw new Error("SQLITE_PATH must be persistent; :memory: is not supported by the self-hosted runtime");
  const redisUrl = optional(env, "REDIS_URL", "redis://127.0.0.1:6379");
  if (realtimeBackend === "redis") {
    let protocol = "";
    try { protocol = new URL(redisUrl).protocol; } catch { throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL"); }
    if (protocol !== "redis:" && protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  return {
    port: port(env, "PORT", "8787"),
    trustProxy: trustProxy === "1",
    webRoot: optional(env, "WEB_ROOT", "web"),
    databaseBackend,
    realtimeBackend,
    db: {
      host: optional(env, "DB_HOST", "127.0.0.1"),
      port: port(env, "DB_PORT", "3306"),
      user: optional(env, "DB_USER", "ongeki"),
      password: env.DB_PASSWORD ?? "",
      database: optional(env, "DB_NAME", "ongeki_collab"),
    },
    sqlitePath,
    redisUrl,
    secrets: {
      identityHash: secret32(env, "IDENTITY_HASH_SECRET"),
      keyEncryption: secret32(env, "KEY_ENCRYPTION_SECRET"),
      ticketSigning: secret32(env, "TICKET_SIGNING_SECRET"),
      adminReset: env.ADMIN_RESET_SECRET ?? "",
    },
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || undefined,
  };
}
