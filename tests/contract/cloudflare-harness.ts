import { env } from "cloudflare:workers";
import worker from "../../src/runtimes/cloudflare/worker.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, vi } from "vitest";
import type { Env } from "../../src/types.js";
import type { ContractHarness, ContractRequest, WsInbox } from "./harness.js";
import { TEST_ORIGIN, testIp } from "./harness.js";

const bindings = env as Env;
const endpoint = TEST_ORIGIN;

interface SocketMessage { text?: string; binary?: ArrayBuffer | Blob }

function socketInbox(socket: WebSocket): WsInbox {
  const messages: SocketMessage[] = [];
  let closeInfo: { code: number; reason: string } | null = null;
  let closeNotify: (() => void) | null = null;
  socket.addEventListener("message", (event) => {
    messages.push(typeof event.data === "string" ? { text: event.data } : { binary: event.data as ArrayBuffer | Blob });
  });
  socket.addEventListener("close", (event) => {
    closeInfo = { code: event.code, reason: event.reason ?? "" };
    closeNotify?.();
  });
  socket.accept();
  return {
    async control(type: string) {
      await vi.waitFor(() => expect(messages.some((message) => message.text !== undefined &&
        (JSON.parse(message.text) as Record<string, unknown>).type === type)).toBe(true), { timeout: 4000 });
      const index = messages.findIndex((message) => message.text !== undefined &&
        (JSON.parse(message.text) as Record<string, unknown>).type === type);
      const text = messages.splice(index, 1)[0].text!;
      return JSON.parse(text) as Record<string, unknown>;
    },
    async binary() {
      await vi.waitFor(() => expect(messages.some((message) => message.binary !== undefined)).toBe(true), { timeout: 4000 });
      const index = messages.findIndex((message) => message.binary !== undefined);
      const data = messages.splice(index, 1)[0].binary!;
      return data instanceof Blob ? await data.arrayBuffer() : data;
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

async function adminToken(): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async (request: Request | URL | string) => {
    expect(String(request)).toBe(`${bindings.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  }));
  return new SignJWT({ email: "admin@example.test" }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(bindings.ACCESS_TEAM_DOMAIN).setAudience(bindings.ACCESS_AUD)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

export function buildCloudflareHarness(): ContractHarness {
  let cachedToken: string | null = null;
  return {
    backend: "cloudflare",
    async http(path: string, init: ContractRequest = {}) {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", init.ip ?? testIp());
      if (init.body !== undefined) headers.set("content-type", "application/json");
      return worker.fetch(new Request(`${endpoint}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }), bindings);
    },
    async admin(path: string, init: ContractRequest = {}) {
      cachedToken ??= await adminToken();
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", cachedToken);
      headers.set("origin", endpoint);
      headers.set("content-type", "application/json");
      const response = await worker.fetch(new Request(`${endpoint}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
      }), bindings);
      vi.restoreAllMocks();
      return response;
    },
    async adminUnauthenticated(path: string, init: ContractRequest = {}) {
      const headers = new Headers(init.headers);
      headers.set("origin", endpoint);
      headers.set("content-type", "application/json");
      return worker.fetch(new Request(`${endpoint}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
      }), bindings);
    },
    async connectRoom(wsPath: string, ticket: string): Promise<WsInbox> {
      const response = await worker.fetch(new Request(`${endpoint}${wsPath}?ticket=${encodeURIComponent(ticket)}`, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
      }), bindings);
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();
      return socketInbox(response.webSocket!);
    },
    async connectSpectator(roomId: string): Promise<WsInbox> {
      const response = await worker.fetch(new Request(`${endpoint}/api/v1/rooms/${roomId}/live`, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
      }), bindings);
      expect(response.status).toBe(101);
      return socketInbox(response.webSocket!);
    },
    async watchDirectory(pool: string): Promise<WsInbox> {
      const response = await worker.fetch(new Request(`${endpoint}/api/v1/live?pool=${encodeURIComponent(pool)}`, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
      }), bindings);
      expect(response.status).toBe(101);
      return socketInbox(response.webSocket!);
    },
    async rejectedUpgradeStatus(path: string): Promise<number> {
      const response = await worker.fetch(new Request(`${endpoint}${path}`, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
      }), bindings);
      return response.status;
    },
    unauthorizedStatus: () => 403,
    async loginStatus() {
      // The login endpoint does not exist on Cloudflare deployments.
      const response = await worker.fetch(new Request(`${endpoint}/admin/api/login`, {
        method: "POST",
        headers: { origin: endpoint, "content-type": "application/json" },
        body: JSON.stringify({ password: "definitely-wrong" }),
      }), bindings);
      return response.status;
    },
  };
}
