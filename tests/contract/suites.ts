import { describe, expect, it, vi } from "vitest";
import { signToken } from "../../src/core/crypto.js";
import { COLLAB_PROTOCOL_VERSION, decodeFrame, encodeFrame } from "../../src/core/protocol.js";
import type { ContractHarness, WsInbox } from "./harness.js";
import { anonKey, hashC, song, testIp, uniquePool } from "./harness.js";

const TICKET_SECRET = Buffer.alloc(32, 3).toString("base64");

interface MatchResult { roomId: string; peerId: number; ticket: string; wsPath: string }

/** The deployment-agnostic protocol contract. Every scenario here runs once
 *  against the Cloudflare harness and once against the self-hosted harness. */
export function describeContract(harness: ContractHarness): void {
  const backend = harness.backend;

  async function http(path: string, init?: Parameters<ContractHarness["http"]>[1]): Promise<Response> {
    return harness.http(path, init);
  }

  async function matchAnonymous(pool: string, username: string, seed: number, roomId?: string,
    manifest = song(), gameVersion = "1.50.1"): Promise<MatchResult> {
    const response = await http("/api/v1/match", {
      method: "POST",
      body: { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: roomId ?? null, gameVersion, username, cardId: 1000 + seed,
        song: manifest, anonymousKey: anonKey(seed) },
      ip: testIp(),
    });
    expect(response.status).toBe(200);
    return await response.json() as MatchResult;
  }

  describe(`contract: core endpoints (${backend})`, () => {
    it("answers the health probe", async () => {
      const response = await http("/api/v1/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, protocol: 1 });
    });

    it("reports the identity mode publicly", async () => {
      const response = await http("/api/v1/identity-mode", { ip: testIp() });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ required: false });
    });

    it("requires the current protocol version before matchmaking", async () => {
      const common = { pool: uniquePool(), roomId: null, gameVersion: "1.50.1",
        username: "Version check", song: song(), anonymousKey: anonKey(7) };
      const missing = await http("/api/v1/match", { method: "POST", body: common, ip: testIp() });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "Invalid protocolVersion" });
      const unsupported = await http("/api/v1/match", { method: "POST",
        body: { ...common, protocolVersion: COLLAB_PROTOCOL_VERSION + 1 }, ip: testIp() });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toEqual({ error: "Invalid protocolVersion" });
    });

    it("requires websockets for the room and live endpoints", async () => {
      expect((await http("/room", { ip: testIp() })).status).toBe(426);
      expect((await http("/api/v1/live?pool=x", { ip: testIp() })).status).toBe(426);
      expect((await http(`/api/v1/rooms/00000000-0000-4000-8000-000000000000/live`, { ip: testIp() })).status).toBe(426);
    });
  });

  describe(`contract: identity (${backend})`, () => {
    it("binds an identity, proves a challenge and rejects replay", async () => {
      const pool = uniquePool();
      const unique = crypto.randomUUID().slice(0, 8);
      const identity = { keychipid: `K-${pool}`, accessCode: `A-${unique}`, userId: `U-${unique}`, server: "https://member.example.test" };
      const clientKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const register = await http("/api/v1/identity/register", {
        method: "POST", body: { ...identity, clientKey: Buffer.from(clientKey).toString("base64") }, ip: testIp(),
      });
      expect(register.status).toBe(201);
      const { identityId } = await register.json() as { identityId: string };

      // Idempotent rebinding with the same key; conflict with a different one.
      expect((await http("/api/v1/identity/register", { method: "POST", body: { ...identity, clientKey: Buffer.from(clientKey).toString("base64") }, ip: testIp() })).status).toBe(200);
      expect((await http("/api/v1/identity/register", { method: "POST", body: { ...identity, clientKey: Buffer.from(new Uint8Array(32).fill(5)).toString("base64") }, ip: testIp() })).status).toBe(409);

      const challenge = await http("/api/v1/identity/challenge", { method: "POST", body: { identityId }, ip: testIp() });
      expect(challenge.status).toBe(200);
      const { challengeId, nonce } = await challenge.json() as { challengeId: string; nonce: string };

      const key = await crypto.subtle.importKey("raw", clientKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const proof = Buffer.from(await crypto.subtle.sign("HMAC", key,
        new TextEncoder().encode(`OngekiCollab/v1/session\n${challengeId}\n${nonce}`))).toString("base64");
      const session = await http("/api/v1/identity/session", { method: "POST", body: { identityId, challengeId, proof, identity }, ip: testIp() });
      expect(session.status).toBe(200);
      const { token } = await session.json() as { token: string };

      // The consumed challenge cannot authenticate a second time.
      expect((await http("/api/v1/identity/session", { method: "POST", body: { identityId, challengeId, proof, identity }, ip: testIp() })).status).toBe(401);

      // With identity checks enabled the session token authorizes a match and
      // anonymous keys are refused; restoring the default keeps other suites valid.
      expect((await harness.admin("/admin/api/identity-mode", { method: "PUT", body: { required: true } })).status).toBe(200);
      try {
        expect((await http("/api/v1/match", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: null, gameVersion: "1.50.1", username: "Registered", song: song() },
          ip: testIp(),
        })).status).toBe(200);
        expect((await http("/api/v1/match", {
          method: "POST",
          body: { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: null, gameVersion: "1.50.1", username: "Anonymous", song: song(), anonymousKey: anonKey(15) },
          ip: testIp(),
        })).status).toBe(401);
      } finally {
        expect((await harness.admin("/admin/api/identity-mode", { method: "PUT", body: { required: false } })).status).toBe(200);
      }
    });
  });

  describe(`contract: matchmaking (${backend})`, () => {
    it("keeps rooms isolated and joins another room only by naming it", async () => {
      const pool = uniquePool();
      const first = await matchAnonymous(pool, "Host", 11);
      const second = await matchAnonymous(pool, "Second", 12);
      expect(second.roomId).not.toBe(first.roomId);

      // Game-version differences are deliberately allowed for an explicit
      // same-song join; only pool, recruiting status and song id isolate rooms.
      const joined = await matchAnonymous(pool, "Third", 13, first.roomId, song(), "1.60.0");
      expect(joined.roomId).toBe(first.roomId);
      const rooms = await (await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as
        { items: Array<{ id: string; players: unknown[] }> };
      expect(rooms.items.find((room) => room.id === first.roomId)?.players).toHaveLength(2);
    });

    it("rejects a join when the song id differs", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 21);
      const response = await http("/api/v1/match", {
        method: "POST",
        body: { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: host.roomId, gameVersion: "1.50.1", username: "Late",
          song: { ...song(), id: 2000 }, anonymousKey: anonKey(22) },
        ip: testIp(),
      });
      expect(response.status).toBe(409);
    });
  });

  describe(`contract: room relay (${backend})`, () => {
    it("guards the socket with the ticket and rejects bad frames", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 31);

      // A ticket presented at another pool's path is refused.
      expect(await harness.rejectedUpgradeStatus(`/room/other-${pool.slice(5)}?ticket=${encodeURIComponent(host.ticket)}`)).toBe(401);
      // An expired ticket is refused.
      const expired = await signToken(TICKET_SECRET, {
        type: "room", roomId: host.roomId, identityId: `anon:${"0".repeat(64)}`, peerId: host.peerId,
        reservationId: "x", pool, exp: Date.now() - 1,
      });
      expect(await harness.rejectedUpgradeStatus(`${host.wsPath}?ticket=${encodeURIComponent(expired)}`)).toBe(401);

      const socket = await harness.connectRoom(host.wsPath, host.ticket);
      try {
        const snapshot = await waitControl(socket, "snapshot");
        expect(snapshot.peerId).toBe(host.peerId);
        expect(snapshot.hostPeerId).toBe(host.peerId);
        expect(await harness.rejectedUpgradeStatus(`${host.wsPath}?ticket=${encodeURIComponent(host.ticket)}`)).toBe(409);
        socket.sendText(JSON.stringify({ type: "ready", song: song(), rttMs: 30 }));
        const readyState = await waitControl(socket, "readyState");
        expect((readyState.players as Array<Record<string, unknown>>)[0]).toMatchObject({ ready: true, chartSha256: hashC });
        // The UDP relay only accepts the whitelisted ports.
        socket.sendBinary(encodeFrame({ kind: 1, sender: 0, target: 0, streamId: 7, sequence: 1, payload: new Uint8Array([9]) }));
        expect((await waitControl(socket, "error")).code).toBe("invalid_udp_port");
      } finally {
        socket.close();
      }
    });

    it("relays binary frames between two players with sender rewrite", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 41);
      const guest = await matchAnonymous(pool, "Guest", 42, host.roomId);
      const hostSocket = await harness.connectRoom(host.wsPath, host.ticket);
      const guestSocket = await harness.connectRoom(guest.wsPath, guest.ticket);
      try {
        const hostSnapshot = await waitControl(hostSocket, "snapshot");
        expect((hostSnapshot.players as Array<Record<string, unknown>>).find((player) => player.peerId === guest.peerId))
          .toMatchObject({ name: "Guest", cardId: 1042, connected: false });
        expect(await waitControl(hostSocket, "peerConnected")).toMatchObject({
          peerId: guest.peerId, name: "Guest", cardId: 1042,
        });
        await waitControl(guestSocket, "snapshot");
        hostSocket.sendBinary(encodeFrame({ kind: 1, sender: 0, target: 0, streamId: 50000, sequence: 3, payload: new Uint8Array([4, 5, 6]) }));
        const relayed = decodeFrame(await guestSocket.binary());
        expect(relayed.sender).toBe(host.peerId);
        expect(relayed.streamId).toBe(50000);
        expect([...relayed.payload]).toEqual([4, 5, 6]);
        // A frame claiming another sender is refused.
        guestSocket.sendBinary(encodeFrame({ kind: 1, sender: host.peerId, target: 0, streamId: 50002, sequence: 4, payload: new Uint8Array([1]) }));
        expect((await waitControl(guestSocket, "error")).code).toBe("wrong_sender");
      } finally {
        hostSocket.close();
        guestSocket.close();
      }
    });

    it("reports joined player profiles and closes a recruiting room when its host disconnects", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 43);
      const hostSocket = await harness.connectRoom(host.wsPath, host.ticket);
      let guestSocket: WsInbox | null = null;
      try {
        await waitControl(hostSocket, "snapshot");
        const guest = await matchAnonymous(pool, "Guest", 44, host.roomId);
        expect(await waitControl(hostSocket, "peerJoined")).toMatchObject({
          peerId: guest.peerId, name: "Guest", cardId: 1044,
        });

        guestSocket = await harness.connectRoom(guest.wsPath, guest.ticket);
        await waitControl(guestSocket, "snapshot");
        hostSocket.sendText(JSON.stringify({ type: "endPlay", reason: "completed" }));
        expect(await waitControl(hostSocket, "error")).toMatchObject({ code: "not_host_or_playing" });

        const recruiting = await (await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as
          { items: Array<{ id: string; status: string }> };
        expect(recruiting.items).toContainEqual(expect.objectContaining({ id: host.roomId, status: "recruiting" }));

        hostSocket.close();
        expect(await waitControl(guestSocket, "roomClosing")).toEqual({
          type: "roomClosing", reason: "host_disconnect",
        });
        expect(await guestSocket.closed()).toEqual({ code: 1000, reason: "host_disconnect" });
        await vi.waitFor(async () => {
          const rooms = await (await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as
            { items: unknown[] };
          expect(rooms.items).toHaveLength(0);
        }, { timeout: 5000 });
      } finally {
        guestSocket?.close();
        hostSocket.close();
      }
    });
  });

  describe(`contract: play lifecycle and history (${backend})`, () => {
    it("reuses only an unconnected reservation for the same song, independent of game version", async () => {
      const pool = uniquePool();
      const first = await matchAnonymous(pool, "Host", 47, undefined, song(), "1.50.1");
      const retried = await matchAnonymous(pool, "Host", 47, undefined, song(), "1.60.0");
      expect(retried.roomId).toBe(first.roomId);
      expect(retried.ticket).not.toBe(first.ticket);
      expect(await harness.rejectedUpgradeStatus(`${first.wsPath}?ticket=${encodeURIComponent(first.ticket)}`)).toBe(409);
      const socket = await harness.connectRoom(retried.wsPath, retried.ticket);
      try { expect((await waitControl(socket, "snapshot")).peerId).toBe(1); }
      finally { socket.close(); }
    });

    it("retires an unconnected old selection before creating a room for another song", async () => {
      const pool = uniquePool();
      const first = await matchAnonymous(pool, "Host", 48);
      const replacementSong = { ...song(), id: 2000, title: "Replacement Overture" };
      const replacement = await matchAnonymous(pool, "Host", 48, undefined, replacementSong, "1.60.0");
      expect(replacement.roomId).not.toBe(first.roomId);
      expect(await harness.rejectedUpgradeStatus(`${first.wsPath}?ticket=${encodeURIComponent(first.ticket)}`)).toBe(409);
      const rooms = await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`);
      const payload = await rooms.json() as { items: Array<{ id: string; song: { id: number } }> };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({ id: replacement.roomId, song: { id: 2000 } });
      const socket = await harness.connectRoom(replacement.wsPath, replacement.ticket);
      try { expect((await waitControl(socket, "snapshot")).peerId).toBe(1); }
      finally { socket.close(); }
    });

    it("creates a fresh room when recruiting again before the completed room socket closes", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 49);
      const guest = await matchAnonymous(pool, "Guest", 50, host.roomId);
      const hostSocket = await harness.connectRoom(host.wsPath, host.ticket);
      const guestSocket = await harness.connectRoom(guest.wsPath, guest.ticket);
      let nextSocket: WsInbox | null = null;
      try {
        await waitControl(hostSocket, "snapshot");
        await waitControl(guestSocket, "snapshot");
        hostSocket.sendText(JSON.stringify({ type: "playStarted" }));
        await waitControl(hostSocket, "playStarted");
        await waitControl(guestSocket, "playStarted");
        hostSocket.sendText(JSON.stringify({ type: "endPlay", reason: "completed" }));
        await waitControl(hostSocket, "playEnded");

        // The previous socket is deliberately still open. This is the real
        // client timing: endPlay makes the room recruiting before its delayed
        // quiet teardown, and a second Match can arrive in that interval.
        const next = await matchAnonymous(pool, "Host", 49);
        expect(next.roomId).not.toBe(host.roomId);
        expect((await hostSocket.closed()).code).toBe(1000);
        const staleJoin = await http("/api/v1/match", { method: "POST", body: {
          protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: host.roomId, gameVersion: "1.60.0", username: "Late", song: song(), anonymousKey: anonKey(53),
        }, ip: testIp() });
        expect(staleJoin.status).toBe(409);
        nextSocket = await harness.connectRoom(next.wsPath, next.ticket);
        expect((await waitControl(nextSocket, "snapshot")).peerId).toBe(1);
      } finally {
        nextSocket?.close();
        guestSocket.close();
        hostSocket.close();
      }
    });

    it("records a passive play with live scores and final history", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 51);
      const guest = await matchAnonymous(pool, "Guest", 52, host.roomId);
      const hostSocket = await harness.connectRoom(host.wsPath, host.ticket);
      const guestSocket = await harness.connectRoom(guest.wsPath, guest.ticket);
      const spec = await harness.connectSpectator(host.roomId);
      try {
        await waitControl(hostSocket, "snapshot");
        await waitControl(guestSocket, "snapshot");
        expect((await waitControl(spec, "scores")).type).toBe("scores");

        hostSocket.sendText(JSON.stringify({ type: "ready", song: song(), rttMs: 30 }));
        guestSocket.sendText(JSON.stringify({ type: "ready", song: song(), rttMs: 35 }));
        await waitControl(hostSocket, "readyState");
        hostSocket.sendText(JSON.stringify({ type: "playStarted" }));
        await waitControl(hostSocket, "playStarted");
        await waitControl(guestSocket, "playStarted");

        guestSocket.sendText(JSON.stringify({ type: "score", techScore: 5432,
          battleScore: -1, bulletHitCount: "invalid", playStatus: "invalid-status!" }));
        expect(await waitControl(hostSocket, "scoreState")).toEqual({
          type: "scoreState", peerId: guest.peerId, techScore: 5432,
        });
        await waitForScores(spec, (players) => players.some((player) => player.peerId === guest.peerId && player.techScore === 5432));

        // A guest drop freezes as Disconnect while the host stays connected.
        guestSocket.close();
        await waitForScores(spec, (players) => players.some((player) => player.peerId === guest.peerId && player.name === "Disconnect"));

        hostSocket.sendText(JSON.stringify({ type: "endPlay", reason: "completed" }));
        expect((await waitControl(hostSocket, "playEnded")).reason).toBe("completed");

        const history = await (await http(`/api/v1/history?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as
          { items: Array<{ players: Array<Record<string, unknown>>; endedAt: number | null }> };
        const play = history.items[0];
        expect(play.endedAt).not.toBeNull();
        expect(play.players.find((player) => player.peerId === guest.peerId)).toMatchObject({ techScore: 5432, serverDomain: "anonymous" });
        expect(JSON.stringify(play)).not.toContain("member.example.test");
      } finally {
        hostSocket.close();
        guestSocket.close();
        spec.close();
      }
    });

    it("closes the room when the last player disconnects", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 61);
      const socket = await harness.connectRoom(host.wsPath, host.ticket);
      try {
        await waitControl(socket, "snapshot");
      } finally {
        socket.close();
      }
      // The close path persists asynchronously; poll until the directory drops it.
      const deadline = Date.now() + 5000;
      for (;;) {
        const rooms = await (await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as { items: unknown[] };
        if (rooms.items.length === 0) break;
        if (Date.now() > deadline) throw new Error("room still listed after close");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  });

  describe(`contract: directory websocket (${backend})`, () => {
    it("pushes exact-pool snapshots without chart hashes", async () => {
      const pool = uniquePool();
      const other = uniquePool();
      const host = await matchAnonymous(pool, "Host", 71);
      const directory = await harness.watchDirectory(pool);
      const otherDirectory = await harness.watchDirectory(other);
      try {
        const snapshot = await waitControl(directory, "snapshot");
        const room = (snapshot.rooms as { items: Array<{ id: string; players: Array<{ peerId: number; cardId: number }> }> })
          .items.find((item) => item.id === host.roomId);
        expect(room?.players).toContainEqual(expect.objectContaining({ peerId: 1, cardId: 1071 }));
        expect(((await waitControl(otherDirectory, "snapshot")).rooms as { items: unknown[] }).items).toHaveLength(0);
        expect(JSON.stringify(snapshot)).not.toContain("sha256");
      } finally {
        directory.close();
        otherDirectory.close();
      }
    });
  });

  describe(`contract: admin (${backend})`, () => {
    it("fails closed without credentials", async () => {
      expect((await harness.adminUnauthenticated("/admin/api/identity-mode")).status).toBe(harness.unauthorizedStatus());
      expect((await harness.adminUnauthenticated("/admin/api/players")).status).toBe(harness.unauthorizedStatus());
      const login = await harness.loginStatus("definitely-wrong");
      if (backend === "selfhost") {
        expect(login).toBe(401);
        // The console shell is a public SPA; unauthenticated visitors get the
        // page (and are bounced to /admin/login client-side), never the data.
        const shell = await harness.adminUnauthenticated("/admin");
        expect(shell.status).toBe(200);
        expect(shell.headers.get("content-type") ?? "").toContain("text/html");
      } else {
        expect([403, 404]).toContain(login as number);
        expect((await harness.adminUnauthenticated("/admin")).status).toBe(403);
      }
    });

    it("toggles the identity mode and lists players and battles", async () => {
      expect((await harness.admin("/admin/api/identity-mode")).status).toBe(200);
      const put = await harness.admin("/admin/api/identity-mode", { method: "PUT", body: { required: false } });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ required: false });
      expect((await harness.admin("/admin/api/players")).status).toBe(200);
      expect((await harness.admin("/admin/api/battles")).status).toBe(200);
      expect((await harness.admin("/admin/api/identity-mode", { method: "PUT", body: { required: "false" } })).status).toBe(400);
      expect((await harness.admin("/admin/api/identity-mode", { method: "PUT", body: { required: false, extra: 1 } })).status).toBe(400);
    });

    it("bans a player and disconnects them from their room", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 81);
      const guest = await matchAnonymous(pool, "Guest", 82, host.roomId);
      const guestSocket = await harness.connectRoom(guest.wsPath, guest.ticket);
      try {
        await waitControl(guestSocket, "snapshot");
        const search = await harness.admin(`/admin/api/players?query=Guest`);
        const page = await search.json() as { items: Array<{ id: string; username: string }> };
        const player = page.items.find((item) => item.username === "Guest");
        expect(player).toBeDefined();
        expect((await harness.admin(`/admin/api/players/${encodeURIComponent(player!.id)}/ban`, { method: "POST", body: { reason: "disruption" } })).status).toBe(200);
        const closed = await guestSocket.closed();
        expect(closed.code).toBe(1008);
        // The banned identity cannot re-enter matchmaking until unbanned.
        expect((await http("/api/v1/match", {
          method: "POST",
          body: { protocolVersion: COLLAB_PROTOCOL_VERSION, pool, roomId: null, gameVersion: "1.50.1", username: "Guest", song: song(), anonymousKey: anonKey(82) },
          ip: testIp(),
        })).status).toBe(403);
        expect((await harness.admin(`/admin/api/players/${encodeURIComponent(player!.id)}/unban`, { method: "POST", body: {} })).status).toBe(200);
      } finally {
        guestSocket.close();
      }
    });

    it("closes a battle on admin command", async () => {
      const pool = uniquePool();
      const host = await matchAnonymous(pool, "Host", 91);
      const close = await harness.admin(`/admin/api/battles/${host.roomId}/close`, { method: "POST", body: {} });
      expect(close.status).toBe(200);
      expect(await close.json()).toMatchObject({ closed: true });
      const rooms = await (await http(`/api/v1/rooms?pool=${encodeURIComponent(pool)}`, { ip: testIp() })).json() as { items: unknown[] };
      expect(rooms.items).toHaveLength(0);
    });
  });

  describe(`contract: rate limit (${backend})`, () => {
    it("throttles a hammered endpoint from one client", async () => {
      let saw429 = false;
      for (let attempt = 0; attempt < 60 && !saw429; attempt++) {
        const response = await http("/api/v1/identity/challenge", {
          method: "POST",
          body: { identityId: "00000000-0000-4000-8000-000000000000" },
          ip: backend === "cloudflare" ? "198.51.100.7" : undefined,
        });
        if (response.status === 429) saw429 = true;
      }
      expect(saw429).toBe(true);
    });
  });
}

function waitControl(inbox: WsInbox, type: string): Promise<Record<string, unknown>> {
  return inbox.control(type);
}

/** Scores pushes are frequent; keep consuming until the desired view arrives. */
async function waitForScores(inbox: WsInbox,
  predicate: (players: Array<Record<string, unknown>>) => boolean): Promise<void> {
  const deadline = Date.now() + 6000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("scores predicate not met in time");
    const message = await inbox.control("scores");
    if (predicate(message.players as Array<Record<string, unknown>>)) return;
  }
}
