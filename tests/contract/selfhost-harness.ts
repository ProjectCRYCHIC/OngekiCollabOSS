import { execFile } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, vi } from "vitest";
import type { ContractHarness, ContractRequest, WsInbox } from "./harness.js";
import { testIp, TEST_ORIGIN } from "./harness.js";

const execFileAsync = promisify(execFile);

const ADMIN_PASSWORD = "contract-admin-pass";

export interface SelfhostHarnessOptions {
  port: number;
  databaseBackend: "mysql" | "sqlite";
  realtimeBackend: "redis" | "memory";
  redisDatabase?: number;
}

function wsInbox(socket: WebSocket): WsInbox {
  socket.binaryType = "arraybuffer";
  const messages: Array<{ text?: string; binary?: ArrayBuffer }> = [];
  let closeInfo: { code: number; reason: string } | null = null;
  let closeNotify: (() => void) | null = null;
  socket.addEventListener("message", (event) => {
    messages.push(typeof event.data === "string" ? { text: event.data } : { binary: event.data });
  });
  socket.addEventListener("close", (event) => {
    closeInfo = { code: event.code, reason: event.reason ?? "" };
    closeNotify?.();
  });
  return {
    async control(type: string) {
      await vi.waitFor(() => expect(messages.some((message) => message.text !== undefined &&
        (JSON.parse(message.text) as Record<string, unknown>).type === type)).toBe(true), { timeout: 4000 });
      const index = messages.findIndex((message) => message.text !== undefined &&
        (JSON.parse(message.text) as Record<string, unknown>).type === type);
      return JSON.parse(messages.splice(index, 1)[0].text!) as Record<string, unknown>;
    },
    async binary() {
      await vi.waitFor(() => expect(messages.some((message) => message.binary !== undefined)).toBe(true), { timeout: 4000 });
      const index = messages.findIndex((message) => message.binary !== undefined);
      return messages.splice(index, 1)[0].binary!;
    },
    async closed() {
      if (closeInfo) return closeInfo;
      return new Promise((resolve) => { closeNotify = () => resolve(closeInfo!); });
    },
    sendText(text: string) { socket.send(text); },
    sendBinary(data: Uint8Array) { socket.send(data); },
    close() { socket.close(); },
  };
}

/** Builds one isolated self-host configuration. All four database/realtime
 * combinations run the same deployment-agnostic contract suite. */
export function createSelfhostHarness(options: SelfhostHarnessOptions): {
  ensureStarted(): Promise<void>;
  harness: ContractHarness;
} {
  const base = `http://127.0.0.1:${options.port}`;
  const sqlitePath = join(mkdtempSync(join(tmpdir(), "ongeki-collab-")), "contract.sqlite");
  const redisBase = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
  const redisUrl = new URL(redisBase);
  redisUrl.pathname = `/${options.redisDatabase ?? 0}`;
  const sharedEnv: Record<string, string> = {
    PORT: String(options.port), WEB_ROOT: "web",
    DATABASE_BACKEND: options.databaseBackend, REALTIME_BACKEND: options.realtimeBackend,
    DB_HOST: process.env.TEST_DB_HOST ?? "127.0.0.1", DB_PORT: process.env.TEST_DB_PORT ?? "3307",
    DB_NAME: process.env.TEST_DB_NAME ?? "ongeki_collab_test", DB_USER: process.env.TEST_DB_USER ?? "ongeki",
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? "ongeki-test", SQLITE_PATH: sqlitePath,
    REDIS_URL: redisUrl.toString(),
    IDENTITY_HASH_SECRET: Buffer.alloc(32, 1).toString("base64"),
    KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 2).toString("base64"),
    TICKET_SIGNING_SECRET: Buffer.alloc(32, 3).toString("base64"),
    ADMIN_RESET_SECRET: Buffer.alloc(32, 4).toString("base64"),
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  };
  let startPromise: Promise<void> | null = null;
  let adminCookie: string | null = null;

  const ensureStarted = async (): Promise<void> => {
    startPromise ??= (async () => {
      try {
        await execFileAsync("node", ["scripts/migrate-selfhost.mjs"], { env: { ...process.env, ...sharedEnv } });
      } catch (cause) {
        throw new Error("Self-hosted contract dependency or migration failed. Start test dependencies with "
          + "npm run test:selfhost:deps. Underlying error: " + (cause instanceof Error ? cause.message : String(cause)));
      }
      if (options.databaseBackend === "mysql") {
        const mysql = await import("mysql2/promise");
        const connection = await mysql.createConnection({ host: sharedEnv.DB_HOST, port: Number(sharedEnv.DB_PORT),
          user: sharedEnv.DB_USER, password: sharedEnv.DB_PASSWORD, database: sharedEnv.DB_NAME });
        await connection.query("DELETE FROM service_settings WHERE `key` IN ('admin_password_hash','admin_session_generation')");
        await connection.end();
      }
      if (options.realtimeBackend === "redis") {
        const Redis = (await import("ioredis")).default;
        const testRedis = new Redis(sharedEnv.REDIS_URL);
        await testRedis.flushdb();
        await testRedis.quit();
      }
      const module = await import("../../src/runtimes/selfhost/server.js");
      await module.startServer({ ...process.env, ...sharedEnv });
    })();
    await startPromise;
    const login = await fetch(`${base}/admin/api/login`, { method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }) });
    expect(login.status).toBe(200);
    adminCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  };

  const harness: ContractHarness = {
    backend: "selfhost",
    async http(path: string, init: ContractRequest = {}) {
      const headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      return fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
    async admin(path: string, init: ContractRequest = {}) {
      const headers = new Headers(init.headers);
      headers.set("origin", base);
      headers.set("content-type", "application/json");
      headers.set("cookie", adminCookie ?? "");
      return fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
      });
    },
    async adminUnauthenticated(path: string, init: ContractRequest = {}) {
      const headers = new Headers(init.headers);
      headers.set("origin", base);
      headers.set("content-type", "application/json");
      return fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
      });
    },
    async connectRoom(wsPath: string, ticket: string): Promise<WsInbox> {
      const socket = new WebSocket(`ws://127.0.0.1:${options.port}${wsPath}?ticket=${encodeURIComponent(ticket)}`);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
      });
      return wsInbox(socket);
    },
    async connectSpectator(roomId: string): Promise<WsInbox> {
      const socket = new WebSocket(`ws://127.0.0.1:${options.port}/api/v1/rooms/${roomId}/live`);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("spectator open failed")), { once: true });
      });
      return wsInbox(socket);
    },
    async watchDirectory(pool: string): Promise<WsInbox> {
      const socket = new WebSocket(`ws://127.0.0.1:${options.port}/api/v1/live?pool=${encodeURIComponent(pool)}`);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("directory open failed")), { once: true });
      });
      return wsInbox(socket);
    },
    async rejectedUpgradeStatus(path: string): Promise<number> {
      // Node fetch refuses to send an Upgrade header, so speak raw HTTP.
      return new Promise((resolve, reject) => {
        const url = new URL(`${base}${path}`);
        const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search,
          headers: { upgrade: "websocket", connection: "Upgrade" } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on("error", reject);
        request.end();
      });
    },
    unauthorizedStatus: () => 401,
    async loginStatus(password: string): Promise<number> {
      const response = await fetch(`${base}/admin/api/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      return response.status;
    },
  };
  return { ensureStarted, harness };
}

const defaultHarness = createSelfhostHarness({ port: 8795, databaseBackend: "mysql", realtimeBackend: "redis" });
export const ensureStarted = defaultHarness.ensureStarted;
export function buildSelfhostHarness(): ContractHarness { return defaultHarness.harness; }

void testIp;
void TEST_ORIGIN;
