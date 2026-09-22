const base = "https://collab.anontokyo.jp";
const pool = `smoke-${crypto.randomUUID()}`;
const adminKey = process.env.ADMIN_RESET_SECRET;

const song = {
  id: 987654,
  title: "Relay smoke test",
  artist: "Test",
  genre: "Test",
  version: "test",
  selectedDifficulty: 3,
  level: 1,
  bpm: 120,
  designer: "Test",
  charts: [0, 2, 3].map((difficulty) => ({ difficulty, sha256: String(difficulty + 1).repeat(64) })),
};
const identities = [];
const sockets = [];

async function api(path, method = "GET", data, token, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(data ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.text();
  if (!response.ok || !`${response.headers.get("content-type") ?? ""}`.includes("json"))
    throw new Error(`${path}: ${response.status} ${response.headers.get("content-type")} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

function base64(bytes) { return Buffer.from(bytes).toString("base64"); }

async function login(label) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const identity = { keychipid: `SMOKEK${suffix}`, accessCode: `SMOKEA${suffix}`,
    userId: `SMOKEU${suffix}`, server: `https://${label}.example.test/private` };
  const { identityId } = await api("/api/v1/identity/register", "POST", { ...identity, clientKey: base64(key) });
  identities.push(identityId);
  const { challengeId, nonce } = await api("/api/v1/identity/challenge", "POST", { identityId });
  const material = new TextEncoder().encode(`OngekiCollab/v1/session\n${challengeId}\n${nonce}`);
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = base64(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, material)));
  const { token } = await api("/api/v1/identity/session", "POST", { identityId, identity, challengeId, proof });
  return token;
}

function openSocket(path, ticket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://collab.anontokyo.jp${path}?ticket=${encodeURIComponent(ticket)}`);
    socket.binaryType = "arraybuffer";
    const next = inbox(socket);
    const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); sockets.push(socket); resolve({ socket, next }); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket handshake failed")); }, { once: true });
  });
}

function inbox(socket) {
  const messages = [];
  const waiting = [];
  socket.addEventListener("message", (event) => {
    messages.push(event.data);
    for (const wake of waiting.splice(0)) wake();
  });
  return async (type) => {
    const until = Date.now() + 10000;
    for (;;) {
      const index = messages.findIndex((message) => typeof message === "string"
        ? JSON.parse(message).type === type : type === "binary");
      if (index >= 0) return messages.splice(index, 1)[0];
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${type}`);
      await Promise.race([new Promise((resolve) => waiting.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())))]);
    }
  };
}

try {
  const mode = await api("/api/v1/identity-mode");
  if (typeof mode.required !== "boolean") throw new Error("Invalid identity mode response");
  if (mode.required && !adminKey) throw new Error("ADMIN_RESET_SECRET is required for cleanup");
  const credentials = mode.required
    ? await Promise.all([login("host"), login("guest")])
    : [base64(crypto.getRandomValues(new Uint8Array(32))), base64(crypto.getRandomValues(new Uint8Array(32)))];
  const request = { protocolVersion: 1, pool, gameVersion: "smoke-1", song };
  const hostMatch = await api("/api/v1/match", "POST", {
    ...request, username: "SmokeHost", ...(mode.required ? {} : { anonymousKey: credentials[0] }),
  }, mode.required ? credentials[0] : undefined);
  // Rooms are strictly isolated: the guest must join the host room by id.
  const guestMatch = await api("/api/v1/match", "POST", {
    ...request, roomId: hostMatch.roomId, username: "SmokeGuest", ...(mode.required ? {} : { anonymousKey: credentials[1] }),
  }, mode.required ? credentials[1] : undefined);
  if (guestMatch.roomId !== hostMatch.roomId) throw new Error("Directed join did not enter the host room");
  if (guestMatch.peerId === hostMatch.peerId) throw new Error("Directed join reused the host seat");
  const { socket: host, next: hostNext } = await openSocket(hostMatch.wsPath, hostMatch.ticket);
  const { socket: guest, next: guestNext } = await openSocket(guestMatch.wsPath, guestMatch.ticket);
  const [hostSnapshot, guestSnapshot] = await Promise.all([hostNext("snapshot"), guestNext("snapshot")]);
  if (JSON.parse(hostSnapshot).peerId !== hostMatch.peerId || JSON.parse(guestSnapshot).peerId !== guestMatch.peerId)
    throw new Error("Wrong peer assignment");
  host.send(JSON.stringify({ type: "ready", song, rttMs: 40 }));
  guest.send(JSON.stringify({ type: "ready", song, rttMs: 50 }));
  await Promise.all([hostNext("readyState"), guestNext("readyState")]);
  // Passive flow: the host only notifies that the native play began; the relay
  // records it without gating anyone on a scheduled start.
  host.send(JSON.stringify({ type: "playStarted" }));
  const started = JSON.parse(await hostNext("playStarted"));
  await guestNext("playStarted");
  if (typeof started.playId !== "string") throw new Error("playStarted did not return a playId");
  const frame = new Uint8Array(25);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 0x4f43);
  view.setUint8(2, 1);
  view.setUint8(3, 1);
  view.setUint32(12, 50002);
  view.setUint16(20, 3);
  frame.set([1, 2, 3], 22);
  host.send(frame);
  const forwarded = new Uint8Array(await guestNext("binary"));
  if (new DataView(forwarded.buffer).getUint32(4) !== hostMatch.peerId || forwarded[24] !== 3)
    throw new Error("Binary relay failed");
  const rooms = await api(`/api/v1/rooms?pool=${pool}&limit=2`);
  if (rooms.items[0]?.status !== "playing") throw new Error("Room directory is not playing");
  host.send(JSON.stringify({ type: "endPlay", reason: "completed" }));
  await hostNext("playEnded");
  const history = await api(`/api/v1/history?pool=${pool}&limit=2`);
  if (history.items[0]?.endReason !== "completed" || history.items[0]?.players.length !== 2)
    throw new Error("Completed play is missing from history");
  console.log(`Production smoke passed: identityRequired=${mode.required}, pool=${pool}, room=${hostMatch.roomId}, players=2, WSS relay and history OK`);
} finally {
  for (const socket of sockets) socket.close();
  for (const identityId of identities) {
    try { await api("/api/v1/admin/reset", "POST", { identityId }, undefined, { "x-admin-key": adminKey }); }
    catch (error) { console.error(`Could not reset synthetic identity ${identityId}: ${error.message}`); }
  }
}
