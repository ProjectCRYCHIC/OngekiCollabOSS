import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { AdminAuthenticator, AdminSessionService, SettingsRepository } from "../../core/ports.js";

/** Minimal structural view of the Redis commands the session store needs;
 *  ioredis overloads resolve differently across module resolution modes. */
export interface PasswordSessionStore {
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

const PASSWORD_HASH_KEY = "admin_password_hash";
const SESSION_GENERATION_KEY = "admin_session_generation";
const SESSION_COOKIE = "admin_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SESSION_INDEX_KEY = "admin:sessions";

const sessionKey = (id: string) => `admin:session:${id}`;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function secureCookie(request: Request): boolean {
  // Behind TLS termination the proxy forwards the scheme; direct LAN HTTP stays
  // cookie-usable while reverse-proxied HTTPS deployments get the Secure flag.
  return (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

function sessionCookie(id: string, secure: boolean, maxAge: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

const NO_STORE_JSON = { "content-type": "application/json", "cache-control": "no-store" };

export class PasswordSessionAuthenticator implements AdminAuthenticator {
  constructor(private readonly redis: PasswordSessionStore, private readonly settings: SettingsRepository) {}

  /** Hashes and stores the initial password when (and only when) no admin
   *  password exists yet; never overwrites an existing credential. */
  async bootstrap(initialPassword: string): Promise<boolean> {
    if (!initialPassword) return false;
    if (await this.settings.getValue(PASSWORD_HASH_KEY)) return false;
    await this.settings.setValue(PASSWORD_HASH_KEY, await argon2Hash(initialPassword), Date.now());
    if (!await this.settings.getValue(SESSION_GENERATION_KEY))
      await this.settings.setValue(SESSION_GENERATION_KEY, randomId(), Date.now());
    return true;
  }

  async hasPassword(): Promise<boolean> {
    return Boolean(await this.settings.getValue(PASSWORD_HASH_KEY));
  }

  async setPassword(password: string): Promise<void> {
    await this.settings.setValue(PASSWORD_HASH_KEY, await argon2Hash(password), Date.now());
    await this.settings.setValue(SESSION_GENERATION_KEY, randomId(), Date.now());
    await this.revokeAll();
  }

  async authenticate(request: Request): Promise<boolean> {
    const id = parseCookies(request)[SESSION_COOKIE];
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
    try {
      const [stored, generation] = await Promise.all([
        this.redis.get(sessionKey(id)), this.settings.getValue(SESSION_GENERATION_KEY),
      ]);
      if (!stored) return false;
      const session = JSON.parse(stored) as { generation?: string };
      if (!session.generation || session.generation !== (generation?.value ?? "0")) return false;
      // Sliding expiration: every authenticated call extends the session.
      const extended = await this.redis.expire(sessionKey(id), SESSION_TTL_SECONDS);
      return extended === 1;
    } catch {
      // Fail closed: an unavailable session store must never open the admin API.
      return false;
    }
  }

  async login(request: Request): Promise<Response> {
    let password = "";
    try {
      const input = await request.json() as { password?: unknown };
      if (typeof input.password === "string") password = input.password;
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE_JSON });
    }
    const [row, generation] = await Promise.all([
      this.settings.getValue(PASSWORD_HASH_KEY),
      this.settings.getValue(SESSION_GENERATION_KEY),
    ]);
    let ok = false;
    if (row && password.length >= 1 && password.length <= 1024) {
      try { ok = await argon2Verify(row.value, password); } catch { ok = false; }
    }
    if (!ok) {
      // Constant-shape rejection; never reveal whether a password is initialized.
      return Response.json({ error: "Authentication failed" }, { status: 401, headers: NO_STORE_JSON });
    }
    // Password reset updates the credential and session generation together. A
    // login that began before that commit must not attach the new generation to
    // a password which is no longer current.
    const [currentRow, currentGeneration] = await Promise.all([
      this.settings.getValue(PASSWORD_HASH_KEY),
      this.settings.getValue(SESSION_GENERATION_KEY),
    ]);
    const generationValue = generation?.value ?? "0";
    if (!currentRow || currentRow.value !== row!.value ||
      (currentGeneration?.value ?? "0") !== generationValue) {
      return Response.json({ error: "Authentication failed" }, { status: 401, headers: NO_STORE_JSON });
    }
    const id = randomId();
    await this.redis.set(sessionKey(id), JSON.stringify({ createdAt: Date.now(), generation: generationValue }), "EX", SESSION_TTL_SECONDS);
    await this.redis.sadd(SESSION_INDEX_KEY, id);
    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { ...NO_STORE_JSON, "set-cookie": sessionCookie(id, secureCookie(request), SESSION_TTL_SECONDS) },
    });
  }

  async logout(request: Request): Promise<Response> {
    const id = parseCookies(request)[SESSION_COOKIE];
    if (id && /^[0-9a-f]{64}$/.test(id)) {
      await this.redis.del(sessionKey(id)).catch(() => undefined);
      await this.redis.srem(SESSION_INDEX_KEY, id).catch(() => undefined);
    }
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { ...NO_STORE_JSON, "set-cookie": clearCookie(secureCookie(request)) },
    });
  }

  async revokeAll(): Promise<void> {
    const ids = await this.redis.smembers(SESSION_INDEX_KEY).catch(() => [] as string[]);
    for (const id of ids) await this.redis.del(sessionKey(id)).catch(() => undefined);
    if (ids.length) await this.redis.del(SESSION_INDEX_KEY).catch(() => undefined);
  }
}

export function createAdminSession(authenticator: PasswordSessionAuthenticator): AdminSessionService {
  return {
    login: (request) => authenticator.login(request),
    logout: (request) => authenticator.logout(request),
    revokeAll: () => authenticator.revokeAll(),
    unauthorizedStatus: 401,
  };
}
