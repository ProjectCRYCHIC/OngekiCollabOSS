import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex, hmac, signToken } from "../src/core/crypto";
import { COLLAB_PROTOCOL_VERSION, decodeFrame, encodeFrame, normalizeServer, type SongManifest } from "../src/core/protocol";
import worker from "../src/runtimes/cloudflare/worker";
import type { Env } from "../src/types";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const bindings = env as Env;
const endpoint = "https://collab.example.test";
const clientKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
let requestNumber = 0;
function testIp(): string { return `198.51.100.${++requestNumber % 254 + 1}`; }

type Json = Record<string, unknown>;
type Identity = { keychipid: string; accessCode: string; userId: string; server: string };
type Registered = { identity: Identity; identityId: string; token: string };

function song(charts: SongManifest["charts"] = [
  { difficulty: 0, sha256: hashA }, { difficulty: 2, sha256: hashB }, { difficulty: 3, sha256: hashC },
]): SongManifest {
  return { id: 1000, title: "Test Overture", artist: "Example Artist", genre: "ORIGINAL", version: "1.50",
    selectedDifficulty: 3, level: 13.7, bpm: 180, designer: "Test Designer", charts };
}

async function call(path: string, method = "GET", payload?: unknown, bearer?: string): Promise<Response> {
  const headers = new Headers();
  headers.set("cf-connecting-ip", testIp());
  if (payload !== undefined) headers.set("content-type", "application/json");
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return exports.default.fetch(new Request(`${endpoint}${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
  }));
}

async function json(response: Response): Promise<Json> { return await response.json() as Json; }

async function challenge(identityId: string): Promise<{ challengeId: string; nonce: string }> {
  const response = await call("/api/v1/identity/challenge", "POST", { identityId });
  expect(response.status).toBe(200);
  return await response.json() as { challengeId: string; nonce: string };
}

async function prove(identityId: string, identity: Identity, attempt: { challengeId: string; nonce: string }): Promise<Response> {
  const proof = base64(await hmac(clientKey, `OngekiCollab/v1/session\n${attempt.challengeId}\n${attempt.nonce}`));
  return call("/api/v1/identity/session", "POST", { identityId, identity, challengeId: attempt.challengeId, proof });
}

async function register(server = "https://arcade.example.test/private/endpoint"): Promise<Registered> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const identity: Identity = { keychipid: `KC${suffix}`, accessCode: `ACCESS${suffix}`, userId: `USER${suffix}`, server };
  const response = await call("/api/v1/identity/register", "POST", { ...identity, clientKey: base64(clientKey) });
  expect(response.status).toBe(201);
  const { identityId } = await response.json() as { identityId: string };
  const session = await prove(identityId, identity, await challenge(identityId));
  expect(session.status).toBe(200);
  const { token } = await session.json() as { token: string };
  return { identity, identityId, token };
}

async function match(player: Registered, pool: string | null, manifest = song(), gameVersion = "1.50.1", roomId?: string) {
  const response = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION,
    pool, roomId: roomId ?? null, gameVersion,
    username: `Player-${player.identityId.slice(0, 6)}`, cardId: 7654, song: manifest }, player.token);
  expect(response.status).toBe(200);
  return await response.json() as { roomId: string; peerId: number; ticket: string; wsPath: string; status: string };
}

function uniquePool(): string { return `test-${crypto.randomUUID()}`; }

function socketInbox(socket: WebSocket) {
  const messages: Array<string | ArrayBuffer | Blob> = [];
  socket.addEventListener("message", (event) => { messages.push(event.data as string | ArrayBuffer | Blob); });
  socket.accept();
  return {
    socket,
    async control(type: string): Promise<Json> {
      await vi.waitFor(() => expect(messages.some((message) => typeof message === "string" &&
        (JSON.parse(message) as Json).type === type)).toBe(true), { timeout: 3000 });
      const index = messages.findIndex((message) => typeof message === "string" && (JSON.parse(message) as Json).type === type);
      return JSON.parse(messages.splice(index, 1)[0] as string) as Json;
    },
    async binary(): Promise<ArrayBuffer> {
      await vi.waitFor(() => expect(messages.some((message) => message instanceof ArrayBuffer || message instanceof Blob)).toBe(true), { timeout: 3000 });
      const index = messages.findIndex((message) => message instanceof ArrayBuffer || message instanceof Blob);
      const data = messages.splice(index, 1)[0];
      return data instanceof Blob ? data.arrayBuffer() : data as ArrayBuffer;
    },
  };
}

async function connect(matchResult: Awaited<ReturnType<typeof match>>) {
  const response = await exports.default.fetch(new Request(`${endpoint}${matchResult.wsPath}?ticket=${encodeURIComponent(matchResult.ticket)}`, {
    headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
  }));
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  return socketInbox(response.webSocket!);
}

async function watchDirectory(pool: string) {
  const response = await exports.default.fetch(new Request(`${endpoint}/api/v1/live?pool=${encodeURIComponent(pool)}`, {
    headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
  }));
  expect(response.status).toBe(101);
  return socketInbox(response.webSocket!);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function adminToken(): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async (request: Request | URL | string) => {
    expect(String(request)).toBe("https://collab-test.cloudflareaccess.com/cdn-cgi/access/certs");
    return Response.json({ keys: [jwk] });
  }));
  return new SignJWT({ email: "admin@example.test" }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(bindings.ACCESS_TEAM_DOMAIN).setAudience(bindings.ACCESS_AUD)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

function adminCall(path: string, method: string, token?: string, payload?: unknown, origin = endpoint): Promise<Response> {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (token) headers.set("cf-access-jwt-assertion", token);
  return worker.fetch(new Request(`${endpoint}${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
  }), bindings);
}

describe("Worker, D1 and room integration", () => {
  it("keeps identity checks off by default and gates admin changes behind Access JWT and same-origin requests", async () => {
    expect(await json(await call("/api/v1/identity-mode"))).toMatchObject({ required: false });
    const initialMode = await bindings.DB.prepare("SELECT value FROM service_settings WHERE key = 'identity_required'")
      .first<{ value: string }>();
    expect(initialMode?.value).toBe("0");
    await bindings.DB.prepare("DELETE FROM service_settings WHERE key = 'identity_required'").run();
    expect(await json(await call("/api/v1/identity-mode"))).toMatchObject({ required: false });
    expect((await adminCall("/admin", "GET")).status).toBe(403);
    expect((await adminCall("/admin.html", "GET")).status).toBe(403);
    expect((await adminCall("/admin/api/players", "GET", "invalid.jwt.token")).status).toBe(403);
    expect((await adminCall("/admin/api/identity-mode", "PUT", undefined, { required: false })).status).toBe(403);
    const token = await adminToken();
    const page = await adminCall("/admin", "GET", token);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect((await adminCall("/admin/api/identity-mode", "PUT", token, { required: false }, "https://evil.example.test")).status).toBe(403);
    expect((await adminCall("/admin/api/identity-mode", "PUT", token, { required: "false" })).status).toBe(400);
    try {
      const updated = await adminCall("/admin/api/identity-mode", "PUT", token, { required: false });
      expect(updated.status).toBe(200);
      expect(await json(updated)).toMatchObject({ required: false });
      expect(await json(await adminCall("/admin/api/identity-mode", "GET", token))).toMatchObject({ required: false });
      expect(await json(await call("/api/v1/identity-mode"))).toMatchObject({ required: false });
      const anonymousKey = base64(clientKey);
      const anon = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), gameVersion: "1.50.1", username: "Anonymous", song: song(), anonymousKey });
      expect(anon.status).toBe(200);
      const initial = await anon.json() as { wsPath: string; ticket: string };
      const players = await json(await adminCall("/admin/api/players?query=Anonymous", "GET", token));
      const anonPlayer = (players.items as Array<{ id: string; kind: string }>).find((item) => item.kind === "anonymous");
      expect(anonPlayer?.id).toMatch(/^anon:[0-9a-f]{64}$/);
      expect((await adminCall(`/admin/api/players/${encodeURIComponent(anonPlayer!.id)}/ban`, "POST", token,
        { reason: "arbitrary identity text" })).status).toBe(400);
      const ban = await adminCall(`/admin/api/players/${encodeURIComponent(anonPlayer!.id)}/ban`, "POST", token, { reason: "disruption" });
      expect(ban.status).toBe(200);
      expect(Number((await json(ban)).disconnectedRooms)).toBeGreaterThanOrEqual(1);
      expect((await exports.default.fetch(new Request(`${endpoint}${initial.wsPath}?ticket=${encodeURIComponent(initial.ticket)}`, {
        headers: { Upgrade: "websocket" },
      }))).status).toBe(403);
      expect((await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), gameVersion: "1.50.1", username: "Anonymous", song: song(), anonymousKey })).status).toBe(403);
      expect((await adminCall(`/admin/api/players/${encodeURIComponent(anonPlayer!.id)}/unban`, "POST", token, {})).status).toBe(200);
      const resumed = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), gameVersion: "1.50.1", username: "Anonymous", song: song(), anonymousKey });
      expect(resumed.status).toBe(200);
      const result = await resumed.json() as { roomId: string; wsPath: string; ticket: string };
      const socket = await exports.default.fetch(new Request(`${endpoint}${result.wsPath}?ticket=${encodeURIComponent(result.ticket)}`, {
        headers: { Upgrade: "websocket" },
      }));
      expect(socket.status).toBe(101);
      socket.webSocket?.accept();
      const activeBan = await adminCall(`/admin/api/players/${encodeURIComponent(anonPlayer!.id)}/ban`, "POST", token, {});
      expect(activeBan.status).toBe(200);
      expect(Number((await json(activeBan)).disconnectedRooms)).toBeGreaterThanOrEqual(1);
      const bannedRoom = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(result.roomId).first<{ status: string }>();
      expect(bannedRoom?.status).toBe("closed");
      expect((await adminCall(`/admin/api/players/${encodeURIComponent(anonPlayer!.id)}/unban`, "POST", token, {})).status).toBe(200);
      expect((await adminCall("/admin/api/battles", "GET", token)).status).toBe(200);
      expect((await adminCall("/admin/api/identity-mode", "PUT", token, { required: true })).status).toBe(200);
      expect((await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), gameVersion: "1.50.1", username: "Anonymous", song: song(), anonymousKey })).status).toBe(401);
      expect((await exports.default.fetch(new Request(`${endpoint}${result.wsPath}?ticket=${encodeURIComponent(result.ticket)}`, {
        headers: { Upgrade: "websocket" },
      }))).status).toBe(401);
      const registered = await register();
      const managedPlayers = await json(await adminCall(`/admin/api/players?query=${registered.identityId}`, "GET", token));
      expect(JSON.stringify(managedPlayers)).not.toContain(registered.identity.accessCode);
      expect(JSON.stringify(managedPlayers)).not.toContain(registered.identity.userId);
      const registeredBan = await adminCall(`/admin/api/players/${registered.identityId}/ban`, "POST", token, { reason: "abuse" });
      expect(registeredBan.status).toBe(200);
      expect((await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), gameVersion: "1.50.1", username: "Blocked", song: song() }, registered.token)).status).toBe(403);
      expect((await adminCall(`/admin/api/players/${registered.identityId}/unban`, "POST", token, {})).status).toBe(200);
      const managed = await match(registered, uniquePool());
      const battles = await json(await adminCall("/admin/api/battles", "GET", token));
      expect((battles.items as Array<{ id: string }>).some((item) => item.id === managed.roomId)).toBe(true);
      expect(JSON.stringify(battles)).not.toContain(hashA);
      expect(JSON.stringify(battles)).not.toContain(registered.identity.userId);
      expect((await adminCall(`/admin/api/battles/${managed.roomId}/close`, "POST", token, {})).status).toBe(200);
      const closed = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(managed.roomId).first<{ status: string }>();
      expect(closed?.status).toBe("closed");
    } finally {
      await adminCall("/admin/api/identity-mode", "PUT", token, { required: true });
    }
  });
  it("pushes exact-pool public snapshots without chart hashes", async () => {
    const pool = uniquePool();
    const otherPool = uniquePool();
    expect((await call(`/api/v1/live?pool=${encodeURIComponent(pool)}`)).status).toBe(426);
    const watch = await watchDirectory(pool);
    const other = await watchDirectory(otherPool);
    try {
      const initial = await watch.control("snapshot");
      const otherInitial = await other.control("snapshot");
      expect(initial.rooms).toMatchObject({ items: [], nextCursor: null });
      expect(otherInitial.rooms).toMatchObject({ items: [], nextCursor: null });
      const player = await register();
      const matched = await match(player, pool);
      const changed = await watch.control("snapshot");
      expect(Number(changed.revision)).toBeGreaterThan(Number(initial.revision));
      const items = (changed.rooms as Json).items as Json[];
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(matched.roomId);
      expect(items[0]).not.toHaveProperty("charts");
      expect(items[0].players).toContainEqual(expect.objectContaining({ peerId: 1, cardId: 7654 }));
      expect(JSON.stringify(changed)).not.toContain(hashA);
      expect(JSON.stringify(changed)).not.toContain(player.identity.userId);
      const publicRooms = await json(await call(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`));
      expect((publicRooms.items as Json[])[0]).not.toHaveProperty("charts");
      const game = await connect(matched);
      try {
        const roomSnapshot = await game.control("snapshot");
        expect(roomSnapshot.players).toContainEqual(expect.objectContaining({ peerId: 1, cardId: 7654 }));
        const connected = await watch.control("snapshot");
        expect(((connected.rooms as Json).items as Json[])[0].players).toMatchObject([{ connected: true }]);
      } finally { game.socket.close(); }
      await vi.waitFor(async () => {
        const row = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(matched.roomId).first<{ status: string }>();
        expect(row?.status).toBe("closed");
      }, { timeout: 3000 });
      let closed = await watch.control("snapshot");
      if (((closed.rooms as Json).items as Json[]).length) closed = await watch.control("snapshot");
      expect((closed.rooms as Json).items).toEqual([]);
    } finally {
      watch.socket.close();
      other.socket.close();
    }
  });
  it("does not expose IP literals as a server domain", () => {
    expect(normalizeServer("https://[::ffff:192.0.2.1]/private").domain).toBe("private-host");
    expect(normalizeServer("https://192.0.2.1/private").domain).toBe("private-host");
    expect(normalizeServer("https://arcade.example.test/private").domain).toBe("arcade.example.test");
  });

  it("binds four hashed identity fields, verifies challenge proof and rejects changes or replay", async () => {
    const player = await register();
    const row = await bindings.DB.prepare("SELECT * FROM identities WHERE id = ?").bind(player.identityId).first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    for (const key of ["keychip_hash", "access_hash", "user_hash", "server_hash", "composite_hash"]) {
      expect(row?.[key]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(row?.server_domain).toBe("arcade.example.test");
    const stored = JSON.stringify(row);
    for (const raw of Object.values(player.identity)) expect(stored).not.toContain(raw);
    expect(stored).not.toContain("/private/endpoint");

    const duplicate = await call("/api/v1/identity/register", "POST", { ...player.identity, clientKey: base64(clientKey) });
    expect(duplicate.status).toBe(200);
    expect((await json(duplicate)).identityId).toBe(player.identityId);
    const changedKey = await call("/api/v1/identity/register", "POST", {
      ...player.identity, clientKey: base64(Uint8Array.from({ length: 32 }, (_, index) => index + 2)),
    });
    expect(changedKey.status).toBe(409);
    for (const key of ["keychipid", "accessCode", "userId"] as const) {
      const changed = { ...player.identity, [key]: `${player.identity[key]}new` };
      const rebound = await call("/api/v1/identity/register", "POST", { ...changed, clientKey: base64(clientKey) });
      expect(rebound.status).toBe(409);
    }
    for (const key of ["keychipid", "accessCode", "userId"] as const) {
      const changed = { ...player.identity, [key]: `${player.identity[key]}changed` };
      const denied = await prove(player.identityId, changed, await challenge(player.identityId));
      expect(denied.status).toBe(403);
    }
    const changedCase = { ...player.identity, accessCode: player.identity.accessCode.toLowerCase() };
    expect((await prove(player.identityId, changedCase, await challenge(player.identityId))).status).toBe(403);
    const differentHost = { ...player.identity, server: "https://other.example.test/private/endpoint" };
    expect((await prove(player.identityId, differentHost, await challenge(player.identityId))).status).toBe(403);
    const equivalentUrl = { ...player.identity, server: player.identity.server.replace("https://", "http://").replace("/private/endpoint", ":2080/other/path") };
    expect((await prove(player.identityId, equivalentUrl, await challenge(player.identityId))).status).toBe(200);
    const sameHostRegistration = await call("/api/v1/identity/register", "POST", {
      ...equivalentUrl, clientKey: base64(clientKey),
    });
    expect(sameHostRegistration.status).toBe(200);
    expect((await json(sameHostRegistration)).identityId).toBe(player.identityId);
    const wrong = await challenge(player.identityId);
    expect((await call("/api/v1/identity/session", "POST", {
      identityId: player.identityId, identity: player.identity, challengeId: wrong.challengeId,
      proof: base64(new Uint8Array(32)),
    })).status).toBe(401);
    const oneTime = await challenge(player.identityId);
    expect((await prove(player.identityId, player.identity, oneTime)).status).toBe(200);
    expect((await prove(player.identityId, player.identity, oneTime)).status).toBe(401);
  });

  it("migrates only a proven legacy full-URI binding on the same public hostname", async () => {
    const player = await register();
    const row = await bindings.DB.prepare("SELECT * FROM identities WHERE id = ?")
      .bind(player.identityId).first<Record<string, string>>();
    expect(row).toBeTruthy();
    const legacyServerHash = hex(await hmac(bindings.IDENTITY_HASH_SECRET, `server\u0000${player.identity.server}`));
    const legacyComposite = hex(await hmac(bindings.IDENTITY_HASH_SECRET,
      `identity\u0000${row!.keychip_hash}\u0000${row!.access_hash}\u0000${row!.user_hash}\u0000${legacyServerHash}`));
    await bindings.DB.prepare("UPDATE identities SET server_hash = ?, composite_hash = ? WHERE id = ?")
      .bind(legacyServerHash, legacyComposite, player.identityId).run();
    const changedPath = { ...player.identity, server: "http://arcade.example.test:2080/another/endpoint/" };
    const wrongChallenge = await challenge(player.identityId);
    expect((await call("/api/v1/identity/session", "POST", {
      identityId: player.identityId, identity: changedPath, challengeId: wrongChallenge.challengeId,
      proof: base64(new Uint8Array(32)),
    })).status).toBe(401);
    const stillLegacy = await bindings.DB.prepare("SELECT server_hash FROM identities WHERE id = ?")
      .bind(player.identityId).first<{ server_hash: string }>();
    expect(stillLegacy?.server_hash).toBe(legacyServerHash);
    expect((await prove(player.identityId, changedPath, await challenge(player.identityId))).status).toBe(200);
    const migrated = await bindings.DB.prepare("SELECT server_hash, composite_hash FROM identities WHERE id = ?")
      .bind(player.identityId).first<{ server_hash: string; composite_hash: string }>();
    expect(migrated?.server_hash).toBe(row!.server_hash);
    expect(migrated?.composite_hash).toBe(row!.composite_hash);

    const ipPlayer = await register("http://192.0.2.1:2080/old/path");
    const ipChangedPath = { ...ipPlayer.identity, server: "http://192.0.2.1:2080/new/path" };
    expect((await prove(ipPlayer.identityId, ipChangedPath, await challenge(ipPlayer.identityId))).status).toBe(200);
    const ipRow = await bindings.DB.prepare("SELECT * FROM identities WHERE id = ?")
      .bind(ipPlayer.identityId).first<Record<string, string>>();
    const ipLegacyHash = hex(await hmac(bindings.IDENTITY_HASH_SECRET, `server\u0000${ipPlayer.identity.server}`));
    const ipLegacyComposite = hex(await hmac(bindings.IDENTITY_HASH_SECRET,
      `identity\u0000${ipRow!.keychip_hash}\u0000${ipRow!.access_hash}\u0000${ipRow!.user_hash}\u0000${ipLegacyHash}`));
    await bindings.DB.prepare("UPDATE identities SET server_hash = ?, composite_hash = ? WHERE id = ?")
      .bind(ipLegacyHash, ipLegacyComposite, ipPlayer.identityId).run();
    expect((await prove(ipPlayer.identityId, ipChangedPath, await challenge(ipPlayer.identityId))).status).toBe(403);
  });

  it("keeps rooms strictly isolated and joins another room only by naming it", async () => {
    const players = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      register(`https://backend-${index}.example.test/private/path`)));
    const pool = uniquePool();
    const host = await match(players[0], pool);
    expect(host.wsPath).toMatch(/^\/room\/test-/);
    // Same song and pool: recruiting must never merge a player into another host's room.
    const sameSong = await match(players[1], pool);
    expect(sameSong.roomId).not.toBe(host.roomId);
    // Directed joins fill the remaining seats.
    const joins = await Promise.all(players.slice(1, 4).map((player) => match(player, pool, song(), "1.50.1", host.roomId)));
    for (const join of joins) expect(join.roomId).toBe(host.roomId);
    expect(joins.map((join) => join.peerId).sort()).toEqual([2, 3, 4]);
    // A fifth player cannot enter the full room.
    const full = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: host.roomId, gameVersion: "1.50.1", username: "Full", song: song() }, players[4].token);
    expect(full.status).toBe(409);
    expect(await json(full)).toEqual({ error: "Room unavailable" });
    // Pool must match exactly; the game version is informational and does not
    // isolate otherwise compatible rooms.
    const otherPool = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: uniquePool(), roomId: host.roomId, gameVersion: "1.50.1", username: "Pool", song: song() }, players[5].token);
    expect(otherPool.status).toBe(409);
    // A directed join only needs the room's song id, never identical chart hashes.
    const changedChart = song([{ difficulty: 0, sha256: hashA }, { difficulty: 2, sha256: hashB },
      { difficulty: 3, sha256: "d".repeat(64) }]);
    const secondPool = uniquePool();
    const secondHost = await match(players[5], secondPool);
    const differing = await match(players[6], secondPool, changedChart, "1.60.0", secondHost.roomId);
    expect(differing.roomId).toBe(secondHost.roomId);
    const wrongId = await call("/api/v1/match", "POST", { protocolVersion: COLLAB_PROTOCOL_VERSION, pool: secondPool, roomId: secondHost.roomId, gameVersion: "1.50.1", username: "Wrong", song: { ...song(), id: 1001 } }, players[4].token);
    expect(wrongId.status).toBe(409);
    expect(await json(wrongId)).toEqual({ error: "Room unavailable" });
    // Re-entering a joined room by id returns the caller's own seat; concurrent joins
    // may assign seats in any order, so expect the seat this player actually received.
    const rejoined = await match(players[1], pool, song(), "1.50.1", host.roomId);
    expect(rejoined.roomId).toBe(host.roomId);
    expect(rejoined.peerId).toBe(joins[0].peerId);
  });

  it("invalidates an earlier room ticket when an unconnected reservation is refreshed", async () => {
    const player = await register();
    const pool = uniquePool();
    const earlier = await match(player, pool);
    const refreshed = await match(player, pool);
    expect(refreshed.roomId).toBe(earlier.roomId);
    expect(refreshed.peerId).toBe(earlier.peerId);
    expect(refreshed.ticket).not.toBe(earlier.ticket);
    const replay = await exports.default.fetch(new Request(`${endpoint}${earlier.wsPath}?ticket=${encodeURIComponent(earlier.ticket)}`, {
      headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
    }));
    expect(replay.status).toBe(409);
    const current = await connect(refreshed);
    try {
      expect((await current.control("snapshot")).peerId).toBe(refreshed.peerId);
    } finally {
      current.socket.close();
      await vi.waitFor(async () => {
        const room = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(refreshed.roomId).first<{ status: string }>();
        expect(room?.status).toBe("closed");
      }, { timeout: 3000 });
    }
  });

  it("relays WebSocket frames and exposes ready chart hashes for clients to compare", async () => {
    const [host, guest] = await Promise.all([register(), register("https://other.example.test/private/path")]);
    const pool = uniquePool();
    const hostMatch = await match(host, pool);
    const guestMatch = await match(guest, pool, song(), "1.50.1", hostMatch.roomId);
    expect(guestMatch.roomId).toBe(hostMatch.roomId);
    expect((await call(`/room?ticket=${encodeURIComponent(hostMatch.ticket)}`, "GET")).status).toBe(426);
    const wrongPool = await exports.default.fetch(new Request(`${endpoint}/room?ticket=${encodeURIComponent(hostMatch.ticket)}`, {
      headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
    }));
    expect(wrongPool.status).toBe(401);
    const expired = await signToken(bindings.TICKET_SIGNING_SECRET, {
      type: "room", roomId: hostMatch.roomId, identityId: host.identityId, peerId: hostMatch.peerId,
      pool, exp: Date.now() - 1,
    });
    const expiredResponse = await exports.default.fetch(new Request(`${endpoint}${hostMatch.wsPath}?ticket=${encodeURIComponent(expired)}`, {
      headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
    }));
    expect(expiredResponse.status).toBe(401);
    const hostSocket = await connect(hostMatch);
    const guestSocket = await connect(guestMatch);
    try {
      const snapshot = await hostSocket.control("snapshot");
      expect(snapshot.peerId).toBe(hostMatch.peerId);
      expect(JSON.stringify(snapshot)).not.toContain(host.identity.userId);
      expect(JSON.stringify(snapshot)).not.toContain("/private/path");
      expect((await guestSocket.control("snapshot")).peerId).toBe(guestMatch.peerId);

      hostSocket.socket.send(JSON.stringify({ type: "startRequest" }));
      expect((await hostSocket.control("error")).code).toBe("players_not_ready");
      hostSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 35 }));
      const hostReadyState = await hostSocket.control("readyState");
      expect((hostReadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ ready: true, songId: 1000, chartSha256: hashC });
      hostSocket.socket.send(JSON.stringify({ type: "unready" }));
      const hostUnreadyState = await hostSocket.control("readyState");
      expect((hostUnreadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ ready: false, songId: null, chartSha256: null });
      hostSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 35 }));
      const hostReReadyState = await hostSocket.control("readyState");
      expect((hostReReadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ ready: true, songId: 1000, chartSha256: hashC });
      // A ready whose chart files differ is stored and exposed, never rejected:
      // the server only reports each player's hash and players compare themselves.
      guestSocket.socket.send(JSON.stringify({ type: "ready", song: song([
        { difficulty: 0, sha256: hashA }, { difficulty: 3, sha256: "d".repeat(64) },
      ]), rttMs: 40 }));
      const guestReadyState = await hostSocket.control("readyState");
      expect((guestReadyState.players as Json[]).find((player) => player.peerId === guestMatch.peerId))
        .toMatchObject({ ready: true, songId: 1000, chartSha256: "d".repeat(64) });
      expect((guestReadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ chartSha256: hashC });
      guestSocket.socket.send(JSON.stringify({ type: "unready" }));
      const guestUnreadyState = await hostSocket.control("readyState");
      expect((guestUnreadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ ready: true, songId: 1000, chartSha256: hashC });
      expect((guestUnreadyState.players as Json[]).find((player) => player.peerId === guestMatch.peerId))
        .toMatchObject({ ready: false, songId: null, chartSha256: null });
      hostSocket.socket.send(JSON.stringify({ type: "startRequest" }));
      expect((await hostSocket.control("error")).code).toBe("players_not_ready");
      guestSocket.socket.send(JSON.stringify({ type: "ready", song: song([
        { difficulty: 0, sha256: hashA }, { difficulty: 3, sha256: "d".repeat(64) },
      ]), rttMs: 40 }));
      await hostSocket.control("readyState");
      hostSocket.socket.send(JSON.stringify({ type: "startRequest" }));
      const started = await hostSocket.control("start");
      expect(typeof started.startsAt).toBe("number");
      expect(Number(started.startsAt)).toBeGreaterThan(Date.now());
      await guestSocket.control("start");

      const invalidPort = encodeFrame({ kind: 1, sender: 0, target: 0, streamId: 7, sequence: 1, payload: new Uint8Array([9]) });
      hostSocket.socket.send(invalidPort);
      expect((await hostSocket.control("error")).code).toBe("invalid_udp_port");
      const frame = encodeFrame({ kind: 1, sender: 0, target: 0, streamId: 50002, sequence: 2, payload: new Uint8Array([1, 2, 3]) });
      hostSocket.socket.send(frame);
      const relayed = decodeFrame(await guestSocket.binary());
      expect(relayed.sender).toBe(hostMatch.peerId);
      expect(relayed.streamId).toBe(50002);
      expect([...relayed.payload]).toEqual([1, 2, 3]);

      const live = await json(await call(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`));
      expect((live.items as Json[])[0].status).toBe("playing");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(started.startsAt) - Date.now() + 50)));
      hostSocket.socket.send(JSON.stringify({ type: "endPlay", reason: "completed" }));
      await hostSocket.control("playEnded");
      const history = await json(await call(`/api/v1/history?pool=${encodeURIComponent(pool)}`));
      expect(history.items).toHaveLength(1);
      expect((history.items as Json[])[0].endReason).toBe("completed");
      const publicHistory = await json(await call("/api/v1/history"));
      expect((publicHistory.items as Json[]).some((item) => item.roomId === hostMatch.roomId)).toBe(false);
      // After the reset a fresh ready is accepted with whatever files the player has.
      hostSocket.socket.send(JSON.stringify({ type: "ready", song: song([
        { difficulty: 0, sha256: hashA }, { difficulty: 2, sha256: hashB }, { difficulty: 3, sha256: "d".repeat(64) },
      ]), rttMs: 35 }));
      const reReadyState = await hostSocket.control("readyState");
      expect((reReadyState.players as Json[]).find((player) => player.peerId === hostMatch.peerId))
        .toMatchObject({ ready: true, chartSha256: "d".repeat(64) });
    } finally {
      guestSocket.socket.close();
      hostSocket.socket.close();
      await vi.waitFor(async () => {
        const room = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(hostMatch.roomId).first<{ status: string }>();
        expect(room?.status).toBe("closed");
      }, { timeout: 3000 });
    }
  }, 10_000);

  it("cancels a scheduled play before its start without publishing history", async () => {
    const [host, guest] = await Promise.all([register(), register()]);
    const pool = uniquePool();
    const hostMatch = await match(host, pool);
    const guestMatch = await match(guest, pool, song(), "1.50.1", hostMatch.roomId);
    const hostSocket = await connect(hostMatch);
    const guestSocket = await connect(guestMatch);
    try {
      await hostSocket.control("snapshot");
      await guestSocket.control("snapshot");
      hostSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 0 }));
      guestSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 0 }));
      await hostSocket.control("readyState");
      await guestSocket.control("readyState");
      hostSocket.socket.send(JSON.stringify({ type: "startRequest" }));
      const start = await hostSocket.control("start");
      expect(Number(start.startsAt)).toBeGreaterThan(Date.now());
      await guestSocket.control("start");
      hostSocket.socket.send(JSON.stringify({ type: "endPlay", reason: "cancelled" }));
      const cancelled = await hostSocket.control("playCancelled");
      expect(cancelled.playId).toBe(start.playId);
      const history = await json(await call(`/api/v1/history?pool=${encodeURIComponent(pool)}`));
      expect(history.items).toEqual([]);
      const unfinished = await bindings.DB.prepare("SELECT id FROM plays WHERE id = ?").bind(start.playId).first();
      expect(unfinished).toBeNull();
    } finally {
      guestSocket.socket.close();
      hostSocket.socket.close();
      await vi.waitFor(async () => {
        const room = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(hostMatch.roomId).first<{ status: string }>();
        expect(room?.status).toBe("closed");
      }, { timeout: 3000 });
    }
  });

  it("records a passive playStarted without gating and keeps the legacy startRequest path", async () => {
    const [host, guest] = await Promise.all([register(), register()]);
    const pool = uniquePool();
    const hostMatch = await match(host, pool);
    const guestMatch = await match(guest, pool, song(), "1.50.1", hostMatch.roomId);
    const hostSocket = await connect(hostMatch);
    const guestSocket = await connect(guestMatch);
    try {
      await hostSocket.control("snapshot");
      await guestSocket.control("snapshot");
      // Passive path: no ready handshake, no head count, host-only notification.
      guestSocket.socket.send(JSON.stringify({ type: "playStarted" }));
      expect((await guestSocket.control("error")).code).toBe("not_host_or_recruiting");
      hostSocket.socket.send(JSON.stringify({ type: "playStarted" }));
      const started = await hostSocket.control("playStarted");
      expect(typeof started.playId).toBe("string");
      await guestSocket.control("playStarted");
      const live = await json(await call(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`));
      expect((live.items as Json[])[0].status).toBe("playing");
      // The UDP whitelist stays 50000/50002: Setting (50001) and DeliveryChecker
      // (50003) never enter the relay, matching the WorldLink reference design.
      for (const port of [50001, 50003]) {
        hostSocket.socket.send(encodeFrame({ kind: 1, sender: 0, target: 0, streamId: port, sequence: port, payload: new Uint8Array([1]) }));
        expect((await hostSocket.control("error")).code).toBe("invalid_udp_port");
      }
      const frame = encodeFrame({ kind: 1, sender: 0, target: 0, streamId: 50002, sequence: 9, payload: new Uint8Array([7]) });
      hostSocket.socket.send(frame);
      const relayed = decodeFrame(await guestSocket.binary());
      expect(relayed.sender).toBe(hostMatch.peerId);
      expect([...relayed.payload]).toEqual([7]);
      // endPlay closes the passively recorded play and returns the room to recruiting.
      hostSocket.socket.send(JSON.stringify({ type: "endPlay", reason: "completed" }));
      await hostSocket.control("playEnded");
      const history = await json(await call(`/api/v1/history?pool=${encodeURIComponent(pool)}`));
      expect((history.items as Json[])[0].endReason).toBe("completed");
      // The gated legacy startRequest path still serves clients that predate playStarted.
      hostSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 20 }));
      guestSocket.socket.send(JSON.stringify({ type: "ready", song: song(), rttMs: 20 }));
      await hostSocket.control("readyState");
      hostSocket.socket.send(JSON.stringify({ type: "startRequest" }));
      const legacyStart = await hostSocket.control("start");
      expect(Number(legacyStart.startsAt)).toBeGreaterThan(Date.now());
      await guestSocket.control("start");
    } finally {
      guestSocket.socket.close();
      hostSocket.socket.close();
      await vi.waitFor(async () => {
        const room = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(hostMatch.roomId).first<{ status: string }>();
        expect(room?.status).toBe("closed");
      }, { timeout: 3000 });
    }
  }, 10_000);

  it("streams live scores to spectators, freezes drops as Disconnect and stores final scores", async () => {
    const [host, guest] = await Promise.all([register(), register()]);
    const pool = uniquePool();
    const hostMatch = await match(host, pool);
    const guestMatch = await match(guest, pool, song(), "1.50.1", hostMatch.roomId);
    const hostSocket = await connect(hostMatch);
    const guestSocket = await connect(guestMatch);
    try {
      await hostSocket.control("snapshot");
      await guestSocket.control("snapshot");
      const spectatorResponse = await exports.default.fetch(new Request(`${endpoint}/api/v1/rooms/${hostMatch.roomId}/live`, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": testIp() },
      }));
      expect(spectatorResponse.status).toBe(101);
      const spectator = socketInbox(spectatorResponse.webSocket!);
      try {
        const initial = await spectator.control("scores");
        expect(initial.status).toBe("recruiting");
        expect(initial.players).toHaveLength(2);
        // Public payloads never expose the player's title server.
        expect(JSON.stringify(initial)).not.toContain("example.test");
        hostSocket.socket.send(JSON.stringify({ type: "playStarted" }));
        await guestSocket.control("playStarted");
        const playing = await spectator.control("scores");
        expect(playing.status).toBe("playing");
        guestSocket.socket.send(JSON.stringify({ type: "score", techScore: 1001500, battleScore: 1200, bulletHitCount: 3000, playStatus: "Play" }));
        const guestPlayerScore = await hostSocket.control("scoreState");
        expect(guestPlayerScore).toMatchObject({ peerId: guestMatch.peerId, techScore: 1001500,
          battleScore: 1200, bulletHitCount: 3000, playStatus: "Play" });
        const guestScores = await spectator.control("scores");
        const guestEntry = (guestScores.players as Json[]).find((player) => player.peerId === guestMatch.peerId);
        expect(guestEntry).toMatchObject({ techScore: 1001500, battleScore: 1200, bulletHitCount: 3000, connected: true });
        // A mid-play drop freezes the last score and renames the player.
        guestSocket.socket.close();
        const dropped = await spectator.control("scores");
        const droppedEntry = (dropped.players as Json[]).find((player) => player.peerId === guestMatch.peerId);
        expect(droppedEntry).toMatchObject({ name: "Disconnect", techScore: 1001500, connected: false });
        hostSocket.socket.send(JSON.stringify({ type: "score", techScore: 1001600, battleScore: 1300, bulletHitCount: 3100, playStatus: "Play" }));
        await spectator.control("scores");
        hostSocket.socket.send(JSON.stringify({ type: "endPlay", reason: "completed" }));
        await hostSocket.control("playEnded");
        await spectator.control("scores");
        const history = await json(await call(`/api/v1/history?pool=${encodeURIComponent(pool)}`));
        const players = (history.items as Json[])[0].players as Array<Record<string, unknown>>;
        expect(players.find((player) => player.peerId === guestMatch.peerId)).toMatchObject({ techScore: 1001500, battleScore: 1200 });
        expect(players.find((player) => player.peerId === hostMatch.peerId)).toMatchObject({ techScore: 1001600, battleScore: 1300 });
        expect(JSON.stringify(players)).not.toContain("example.test");
        expect(JSON.stringify(players)).not.toContain(hashA);
      } finally { spectator.socket.close(); }
    } finally {
      hostSocket.socket.close();
      await vi.waitFor(async () => {
        const room = await bindings.DB.prepare("SELECT status FROM rooms WHERE id = ?").bind(hostMatch.roomId).first<{ status: string }>();
        expect(room?.status).toBe("closed");
      }, { timeout: 3000 });
    }
  }, 10_000);

  it("pages exact-pool rooms and includes only plays ending within the rolling 72 hours", async () => {
    const pool = uniquePool();
    const now = Date.now();
    const manifest = JSON.stringify(song());
    const charts = JSON.stringify(song().charts);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < ids.length; index++) {
      await bindings.DB.prepare("INSERT INTO rooms(id,pool,music_id,game_version,status,song_json,charts_json,player_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(ids[index], pool, 1000, "1.50.1", index === 2 ? "closed" : index === 1 ? "playing" : "recruiting",
          manifest, charts, 2, now, now + 3 - index).run();
    }
    const first = await json(await call(`/api/v1/rooms?pool=${pool}&limit=1`));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await json(await call(`/api/v1/rooms?pool=${pool}&limit=1&cursor=${encodeURIComponent(String(first.nextCursor))}`));
    expect(second.items).toHaveLength(1);
    expect((second.items as Json[])[0].id).not.toBe((first.items as Json[])[0].id);
    expect(second.nextCursor).toBeNull();
    expect((await json(await call(`/api/v1/rooms?pool=${pool}x`))).items).toEqual([]);

    const fixedNow = 1_800_000_000_000;
    const cutoff = fixedNow - 72 * 60 * 60_000;
    const playIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < playIds.length; index++) {
      const endedAt = [cutoff - 1, cutoff, cutoff + 1][index];
      await bindings.DB.prepare("INSERT INTO plays(id,room_id,pool,song_json,charts_json,participants_json,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(playIds[index], ids[0], pool, manifest, charts, "[]", endedAt - 1000, endedAt, "completed").run();
    }
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const history = await json(await call(`/api/v1/history?pool=${pool}&limit=1`));
    expect(history.items).toHaveLength(1);
    expect((history.items as Json[])[0].id).toBe(playIds[2]);
    const boundary = await json(await call(`/api/v1/history?pool=${pool}&limit=1&cursor=${encodeURIComponent(String(history.nextCursor))}`));
    expect((boundary.items as Json[])[0].id).toBe(playIds[1]);
    expect(boundary.nextCursor).toBeNull();
    await worker.scheduled({} as ScheduledController, bindings);
    const old = await bindings.DB.prepare("SELECT id FROM plays WHERE id = ?").bind(playIds[0]).first();
    expect(old).toBeNull();
  });
});

describe("Song catalog proxy", () => {
  it("normalizes the upstream catalog once and serves it from the edge cache without chart data", async () => {
    const upstream = {
      updateTime: "2026-09-11T01:41:40.742Z",
      songs: [
        { title: "Test Overture", artist: "Example Artist", category: "オンゲキ", version: "オンゲキ",
          bpm: 180, releaseDate: "2018-07-26", imageName: "aaa.png",
          sheets: [{ difficulty: "basic", level: "3" }, { difficulty: "master", level: "12" }, { difficulty: "bogus", level: "9" }] },
        { title: "No Cover Song", artist: "", category: "VARIETY", version: "bright",
          bpm: "broken", releaseDate: "2021-10-21", imageName: "../escape.png", sheets: [] },
        { title: 42, imageName: "bbb.png" },
      ],
    };
    const upstreamFetch = vi.fn(async () => Response.json(upstream));
    vi.stubGlobal("fetch", upstreamFetch);
    const first = await call("/api/v1/songs");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("max-age=");
    const payload = await json(first) as { updated: string; songs: Json[] };
    expect(payload.updated).toBe("2026-09-11T01:41:40.742Z");
    expect(payload.songs).toEqual([{
      t: "Test Overture", a: "Example Artist", c: "オンゲキ", v: "オンゲキ", b: 180, d: "2018-07-26", i: "aaa.png",
      l: ["3", null, null, "12", null],
    }]);
    expect(JSON.stringify(payload)).not.toMatch(/sha|hash|chart/i);
    const second = await json(await call("/api/v1/songs"));
    expect(second).toEqual(payload);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});
