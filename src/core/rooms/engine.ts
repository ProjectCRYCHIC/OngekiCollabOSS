import { decodeFrame, encodeFrame, MAX_CONTROL_MESSAGE_BYTES, parseSong, SongManifest, utf8Size } from "../protocol.js";
import type { Seat } from "../ports.js";
import type { RoomTicket } from "../tokens.js";
import type { MetaRow, RoomSetup, SocketData } from "./types.js";
import type { RoomStateStore } from "./state-store.js";
import type { RoomPersistence } from "./persistence.js";
import type { RoomDelivery } from "./delivery.js";

export interface Reservation { identityId: string; username: string; cardId?: number; serverDomain: string; song: SongManifest }

function json(value: unknown): string { return JSON.stringify(value); }
function error(message: string, status = 400): Response { return Response.json({ error: message }, { status }); }
const RESERVATION_TIMEOUT_MS = 60_000;
const ACTIVE_ROOM_ALARM_MS = 60 * 60_000;
const DISCONNECT_RETRY_MS = 5_000;

/** A connected room participant or spectator. Hibernation runtimes wrap their
 *  WebSocket attachments in this; plain socket servers hold the fields inline. */
export interface RoomSocket {
  readonly data: SocketData;
  send(message: string): unknown;
  sendBinary(bytes: Uint8Array): unknown;
  close(code: number, reason: string): unknown;
  /** Persist mutated attachment state (no-op outside hibernation runtimes). */
  save(): void;
}

export interface RoomSocketRegistry {
  sockets(): RoomSocket[];
}

export interface RoomEngineCoordinator {
  markOpen(coordinator: string, roomId: string): Promise<void>;
  markClosed(coordinator: string, roomId: string): Promise<void>;
}

export interface RoomEngineDirectory {
  /** Fire-and-forget push of a fresh directory snapshot for the pool. */
  notify(pool: string): void;
}

export interface RoomEngineDeps {
  state: RoomStateStore;
  persist: RoomPersistence;
  pools: RoomEngineCoordinator;
  directory: RoomEngineDirectory;
  registry: RoomSocketRegistry;
  delivery: RoomDelivery;
  scheduleAlarm(at: number): Promise<void> | void;
}

/** Deployment-agnostic room state machine: seat reservations, control messages,
 *  binary frame relaying, play lifecycle, bans and teardown. Transport shells
 *  (Durable Object hibernation, plain WebSocket server) drive it. */
export class RoomEngine {
  constructor(private readonly deps: RoomEngineDeps) {}

  private get state(): RoomStateStore { return this.deps.state; }

  async initialize(setup: RoomSetup): Promise<void> {
    if (await this.state.getMeta()) return;
    const now = Date.now();
    const pool = setup.request.pool ?? "";
    const song = setup.request.song;
    await this.state.insertMeta({ id: setup.id, coordinator: setup.coordinator, pool, game_version: setup.request.gameVersion,
      song_json: json(song), charts_json: json(song.charts), status: "recruiting", host_peer_id: 1, play_id: null, started_at: null, created_at: now });
    try {
      await this.deps.persist.createRoom({ id: setup.id, pool, musicId: song.id, gameVersion: setup.request.gameVersion,
        songJson: json(song), chartsJson: json(song.charts), now });
    } catch (cause) {
      await this.state.deleteMeta(setup.id);
      throw cause;
    }
    // Also protects the initialize -> first host reservation gap: if reserving
    // the creator fails, the otherwise empty room is closed by the alarm.
    await this.deps.scheduleAlarm(now + RESERVATION_TIMEOUT_MS);
  }

  async reserve(reservation: Reservation): Promise<Seat | null> {
    const meta = await this.state.getMeta();
    if (!meta || meta.status !== "recruiting") return null;
    const expected = JSON.parse(meta.song_json) as SongManifest;
    if (expected.id !== reservation.song.id) return null;
    const current = await this.state.getMembers();
    const existing = current.find((member) => member.identity_id === reservation.identityId);
    if (existing) {
      // Only an unconnected seat represents an idempotent HTTP/WebSocket
      // handshake retry. Reusing a seat whose old WebSocket is still connected
      // produces a ticket that validatePlayerConnection must reject; this race
      // is especially visible when a player recruits again immediately after
      // endPlay returns the old room to recruiting.
      if (existing.connected) return null;
      const reservationId = crypto.randomUUID();
      await this.state.rereserve(existing.peer_id, reservationId, Date.now());
      return { peerId: existing.peer_id, reservationId };
    }
    if (current.length >= 4) return null;
    // The room's song id is its identity; chart files may differ between players
    // (data versions) and are compared client-to-client at ready, not here.
    const peerId = [1, 2, 3, 4].find((id) => !current.some((member) => member.peer_id === id));
    if (!peerId) return null;
    const now = Date.now();
    const reservationId = crypto.randomUUID();
    await this.state.insertMember({ peer_id: peerId, identity_id: reservation.identityId, reservation_id: reservationId,
      username: reservation.username, card_id: reservation.cardId ?? 0, server_domain: reservation.serverDomain,
      selected_difficulty: reservation.song.selectedDifficulty,
      level: reservation.song.level, bpm: reservation.song.bpm, designer: reservation.song.designer,
      connected: 0, ready_json: null, rtt_ms: 0, reserved_at: now });
    try {
      await this.deps.persist.reserveSeat({ roomId: meta.id, peerId, identityId: reservation.identityId,
        username: reservation.username, cardId: reservation.cardId ?? 0, serverDomain: reservation.serverDomain,
        selectedDifficulty: reservation.song.selectedDifficulty, level: reservation.song.level,
        bpm: reservation.song.bpm, designer: reservation.song.designer, playerCount: current.length + 1, now });
    } catch (cause) {
      await this.state.deleteMember(peerId);
      throw cause;
    }
    await this.deps.scheduleAlarm(now + RESERVATION_TIMEOUT_MS);
    this.broadcast({ type: "peerJoined", peerId, name: reservation.username, cardId: reservation.cardId ?? 0 });
    this.deps.directory.notify(meta.pool);
    return { peerId, reservationId };
  }

  async validatePlayerConnection(payload: RoomTicket | null): Promise<Response | { meta: MetaRow }> {
    const meta = await this.state.getMeta();
    if (!payload || !meta || payload.roomId !== meta.id || payload.pool !== meta.pool || meta.status !== "recruiting") return error("Room not recruiting", 409);
    const member = await this.state.getMember(payload.peerId);
    if (!member || member.identity_id !== payload.identityId || member.reservation_id !== payload.reservationId || member.connected) return error("Reservation unavailable", 409);
    return { meta };
  }

  async completePlayerConnection(socket: RoomSocket, payload: RoomTicket, meta: MetaRow): Promise<void> {
    await this.state.markConnected(payload.peerId);
    await this.state.touchActive();
    try {
      await this.deps.persist.markConnected(meta.id, payload.peerId);
      // Treat delivery of the initial snapshot as part of the connection
      // transaction. A socket can disappear after admission but before this
      // send; leaving the seat connected in that case creates a ghost member
      // (and, for peer 1, a ghost host) until the next long active-room alarm.
      socket.send(json({ type: "snapshot", roomId: meta.id, peerId: payload.peerId, hostPeerId: meta.host_peer_id,
        status: meta.status, players: await this.publicPlayers() }));
    } catch (cause) {
      await this.state.markDisconnected(payload.peerId);
      await this.deps.scheduleAlarm(Date.now() + DISCONNECT_RETRY_MS);
      socket.close(1011, "Room join failed");
      throw cause;
    }
    const member = await this.state.getMember(payload.peerId);
    this.broadcast({ type: "peerConnected", peerId: payload.peerId, name: member?.username ?? "",
      cardId: member?.card_id ?? 0 }, payload.peerId);
    this.deps.directory.notify(meta.pool);
  }

  async validateSpectator(): Promise<Response | { meta: MetaRow }> {
    const meta = await this.state.getMeta();
    if (!meta || (meta.status !== "recruiting" && meta.status !== "playing")) return error("Room not found", 404);
    if (this.deps.registry.sockets().filter((socket) => socket.data.spectator).length >= 100)
      return error("Room is busy", 503);
    return { meta };
  }

  /** Read-only per-room live score feed for the public dashboard room modal. */
  async addSpectator(socket: RoomSocket, meta: MetaRow): Promise<void> {
    socket.send(json({ type: "scores", roomId: meta.id, playId: meta.play_id, status: meta.status, players: await this.scorePlayers() }));
  }

  /** Live per-player view. A player who dropped mid-play is shown as
   *  "Disconnect" with their last reported score frozen. */
  private async scorePlayers(): Promise<Array<{ peerId: number; name: string; connected: boolean; selectedDifficulty: number | null;
    level: number | null; techScore: number | null; battleScore: number | null; bulletHitCount: number | null; playStatus: string | null }>> {
    const scores = new Map((await this.state.getScores()).map((row) => [row.peer_id, row]));
    const out: Array<{ peerId: number; name: string; connected: boolean; selectedDifficulty: number | null;
      level: number | null; techScore: number | null; battleScore: number | null; bulletHitCount: number | null; playStatus: string | null }> = [];
    for (const member of await this.state.getMembers()) {
      const score = scores.get(member.peer_id);
      scores.delete(member.peer_id);
      const play = parsePlayJson(score?.play_json);
      const dropped = Boolean(score?.disconnected_at) || !member.connected;
      out.push({ peerId: member.peer_id, name: dropped ? "Disconnect" : member.username, connected: !dropped,
        selectedDifficulty: member.selected_difficulty, level: Number(member.level),
        techScore: finiteNumberOrNull(play?.techScore), battleScore: finiteNumberOrNull(play?.battleScore),
        bulletHitCount: finiteNumberOrNull(play?.bulletHitCount), playStatus: typeof play?.playStatus === "string" ? play.playStatus : null });
    }
    for (const score of scores.values()) {
      const play = parsePlayJson(score.play_json);
      out.push({ peerId: score.peer_id, name: "Disconnect", connected: false, selectedDifficulty: null, level: null,
        techScore: finiteNumberOrNull(play?.techScore), battleScore: finiteNumberOrNull(play?.battleScore),
        bulletHitCount: finiteNumberOrNull(play?.bulletHitCount), playStatus: typeof play?.playStatus === "string" ? play.playStatus : null });
    }
    return out;
  }

  private async notifySpectators(): Promise<void> {
    const meta = await this.state.getMeta();
    if (!meta) return;
    const payload = json({ type: "scores", roomId: meta.id, playId: meta.play_id, status: meta.status, players: await this.scorePlayers() });
    this.deps.delivery.notifySpectators(payload);
  }

  /** Ensures every connected member has a live score row. Called when a play
   *  begins. */
  private async seedPlayScores(): Promise<void> {
    for (const member of await this.state.getMembers()) {
      if (!member.connected) continue;
      await this.state.seedScore(member.peer_id, member.username);
    }
  }

  private async markPlayScoreDropped(peerId: number, name: string): Promise<void> {
    await this.state.markScoreDropped(peerId, name, Date.now());
  }

  private async publicPlayers(): Promise<Array<{ peerId: number; name: string; cardId: number; serverDomain: string; selectedDifficulty: number; connected: boolean; ready: boolean; songId: number | null; chartSha256: string | null }>> {
    // The player's title server is identity-bound data and stays internal; public
    // payloads present every player as anonymous. songId/chartSha256 expose each
    // ready player's reported chart so clients can compare between themselves;
    // the server itself never judges chart equality.
    const out: Array<{ peerId: number; name: string; cardId: number; serverDomain: string; selectedDifficulty: number; connected: boolean; ready: boolean; songId: number | null; chartSha256: string | null }> = [];
    for (const member of await this.state.getMembers()) {
      let songId: number | null = null;
      let chartSha256: string | null = null;
      if (member.ready_json) {
        try {
          const song = parseSong(JSON.parse(member.ready_json));
          const chart = song.charts.find((entry) => entry.difficulty === song.selectedDifficulty);
          if (chart) { songId = song.id; chartSha256 = chart.sha256; }
        } catch { /* A malformed stored manifest is reported as not ready. */ }
      }
      out.push({ peerId: member.peer_id, name: member.username, cardId: member.card_id ?? 0,
        serverDomain: "anonymous",
        selectedDifficulty: member.selected_difficulty, connected: Boolean(member.connected), ready: Boolean(member.ready_json),
        songId, chartSha256 });
    }
    return out;
  }

  private broadcast(message: unknown, exceptPeerId = 0): void {
    this.deps.delivery.broadcastText(json(message), exceptPeerId);
  }

  private sendError(socket: RoomSocket, code: string): void {
    socket.send(json({ type: "error", code }));
  }

  async onMessage(socket: RoomSocket, message: string | ArrayBuffer | Uint8Array): Promise<void> {
    const attachment = socket.data;
    if (attachment.spectator) { socket.close(1008, "Read-only room feed"); return; }
    await this.state.touchActive();
    const meta = await this.state.getMeta();
    const member = await this.state.getConnectedMember(attachment.peerId, attachment.identityId);
    if (!meta || (meta.status !== "recruiting" && meta.status !== "playing") || !member) {
      socket.close(1000, "Room unavailable");
      return;
    }
    const now = Date.now();
    if (now - attachment.windowStart >= 1000) { attachment.windowStart = now; attachment.messages = 0; }
    attachment.messages++;
    socket.save();
    if (attachment.messages > 250) { socket.close(1008, "Rate exceeded"); return; }
    if (typeof message === "string") {
      if (utf8Size(message) > MAX_CONTROL_MESSAGE_BYTES) {
        socket.close(1009, "Message too large"); return;
      }
      let control: Record<string, unknown>;
      try { control = JSON.parse(message) as Record<string, unknown>; } catch { this.sendError(socket, "bad_json"); return; }
      await this.handleControl(socket, attachment.peerId, control);
      return;
    }
    let frame;
    try { frame = decodeFrame(message); } catch { this.sendError(socket, "bad_frame"); return; }
    if (frame.sender !== 0 && frame.sender !== attachment.peerId) { this.sendError(socket, "wrong_sender"); return; }
    if (frame.kind === 1 && frame.streamId !== 50000 && frame.streamId !== 50002) { this.sendError(socket, "invalid_udp_port"); return; }
    if (frame.kind !== 1 && frame.target === 0) { this.sendError(socket, "target_required"); return; }
    if (frame.kind !== 1 && frame.streamId === 0) { this.sendError(socket, "stream_required"); return; }
    const peers = (await this.state.getMembers()).filter((member) => member.connected && member.peer_id !== attachment.peerId);
    if (frame.target !== 0 && !peers.some((peer) => peer.peer_id === frame.target)) { this.sendError(socket, "unknown_target"); return; }
    const forwarded = encodeFrame({ ...frame, sender: attachment.peerId });
    this.deps.delivery.forwardFrame(forwarded, attachment.peerId, frame.target === 0 ? null : frame.target);
  }

  private async handleControl(socket: RoomSocket, peerId: number, control: Record<string, unknown>): Promise<void> {
    const type = control.type;
    if (type === "hello") return;
    if (type === "ping") { socket.send(json({ type: "pong", sentAt: control.sentAt ?? null, serverAt: Date.now() })); return; }
    if (type === "unready") {
      const meta = await this.state.getMeta();
      if (!meta || meta.status !== "recruiting") { this.sendError(socket, "not_recruiting"); return; }
      await this.state.clearMemberReady(peerId);
      this.broadcast({ type: "readyState", players: await this.publicPlayers() });
      this.deps.directory.notify(meta.pool);
      return;
    }
    if (type === "ready") {
      const meta = await this.state.getMeta();
      if (!meta || meta.status !== "recruiting") { this.sendError(socket, "not_recruiting"); return; }
      let song: SongManifest;
      try { song = parseSong(control.song); } catch { this.sendError(socket, "bad_song"); return; }
      // The server never judges chart equality: each client reports its own
      // manifest and players compare the readyState hashes between themselves.
      const rtt = Number(control.rttMs);
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > 3000) { this.sendError(socket, "bad_rtt"); return; }
      await this.state.updateReady(peerId, json(song), song.selectedDifficulty, song.level, song.bpm, song.designer, Math.round(rtt));
      await this.deps.persist.updateReady(meta.id, peerId, song.selectedDifficulty, song.level, song.bpm, song.designer);
      this.broadcast({ type: "readyState", players: await this.publicPlayers() });
      this.deps.directory.notify(meta.pool);
      return;
    }
    if (type === "startRequest") { await this.startPlay(socket, peerId); return; }
    if (type === "playStarted") { await this.recordPlayStarted(socket, peerId); return; }
    if (type === "score") { await this.recordScore(peerId, control); return; }
    if (type === "endPlay") {
      const meta = await this.state.getMeta();
      if (!meta || peerId !== meta.host_peer_id || meta.status !== "playing") { this.sendError(socket, "not_host_or_playing"); return; }
      const reason = typeof control.reason === "string" && /^[a-z_]{1,32}$/.test(control.reason) ? control.reason : "completed";
      try { await this.endPlay(reason); }
      catch { this.sendError(socket, "storage_unavailable"); }
      return;
    }
    this.sendError(socket, "unknown_control");
  }

  /** Live score report from a playing client. Stored per room for the spectator
   *  feed and echoed to the other players as a fallback for native Party's
   *  all-member score barrier; a drop freezes the last reported values. */
  private async recordScore(peerId: number, control: Record<string, unknown>): Promise<void> {
    const meta = await this.state.getMeta();
    const member = (await this.state.getMembers()).find((candidate) => candidate.peer_id === peerId);
    if (!meta || meta.status !== "playing" || !member || !member.connected) { return; }
    const score = (value: unknown): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 99_999_999 ? Math.round(parsed) : null;
    };
    const play: Record<string, unknown> = {};
    const techScore = score(control.techScore);
    const battleScore = score(control.battleScore);
    const bulletHitCount = score(control.bulletHitCount);
    if (techScore !== null) play.techScore = techScore;
    if (battleScore !== null) play.battleScore = battleScore;
    if (bulletHitCount !== null) play.bulletHitCount = bulletHitCount;
    if (typeof control.playStatus === "string" && /^[A-Za-z_]{1,24}$/.test(control.playStatus)) play.playStatus = control.playStatus;
    if (!Object.keys(play).length) return;
    const existing = (await this.state.getScores()).find((candidate) => candidate.peer_id === peerId);
    const mergedPlay = { ...(parsePlayJson(existing?.play_json) ?? {}), ...play };
    await this.state.upsertScore(peerId, member.username, json(mergedPlay));
    // Party.Host waits until every active member has a ClientPlayInfo sample before
    // it publishes any PartyPlayInfo. One delayed native stream would otherwise
    // leave every opponent HUD at zero even though their relay score reports arrive.
    // Keep the native stream authoritative when healthy, but give room members the
    // same validated per-player values as a low-rate recovery path.
    this.broadcast({ type: "scoreState", peerId, ...play }, peerId);
    await this.notifySpectators();
  }

  private async startPlay(socket: RoomSocket, peerId: number): Promise<void> {
    const meta = await this.state.getMeta();
    if (!meta || peerId !== meta.host_peer_id || meta.status !== "recruiting") { this.sendError(socket, "not_host_or_recruiting"); return; }
    const members = await this.state.getMembers();
    const connected = members.filter((member) => member.connected);
    const unconnected = members.filter((member) => !member.connected);
    if (connected.length < 2 || connected.some((member) => !member.ready_json)) { this.sendError(socket, "players_not_ready"); return; }
    // No chart gate here either: chart equality is judged client-to-client via
    // the readyState hashes, and the legacy scheduled start is compatibility-only.
    const now = Date.now();
    const playId = crypto.randomUUID();
    const startsAt = now + Math.max(2000, Math.max(...connected.map((member) => member.rtt_ms)) * 2 + 500);
    const participants = connected.map((member) => ({ peerId: member.peer_id, name: member.username, serverDomain: member.server_domain,
      selectedDifficulty: member.selected_difficulty, level: member.level, bpm: member.bpm, designer: member.designer }));
    await this.state.updateMetaTransition({ status: "playing", playId, startedAt: startsAt });
    await this.seedPlayScores();
    try {
      await this.deps.persist.startPlay({ playId, roomId: meta.id, pool: meta.pool, songJson: meta.song_json,
        chartsJson: meta.charts_json, participantsJson: json(participants), startedAt: startsAt, playerCount: connected.length, now });
    } catch (cause) {
      await this.state.updateMetaTransition({ status: "recruiting", playId: null, startedAt: null });
      throw cause;
    }
    for (const member of unconnected) await this.state.deleteMember(member.peer_id);
    this.broadcast({ type: "start", playId, startsAt });
    await this.notifySpectators();
    this.deps.directory.notify(meta.pool);
  }

  // Passive (dumb-switch) play recording. The native Party state machine owns the
  // start timing over the relayed sockets; the server only records that the host
  // began playing. Unlike startPlay it performs no readiness, head-count or chart
  // gating and schedules nothing. Clients compare the readyState hashes before
  // reporting playStarted. Clients that predate it keep the gated startRequest
  // path above.
  private async recordPlayStarted(socket: RoomSocket, peerId: number): Promise<void> {
    const meta = await this.state.getMeta();
    if (!meta || peerId !== meta.host_peer_id || meta.status !== "recruiting") {
      // A duplicate playStarted while already playing is idempotent: the native
      // state machine owns start timing and may re-affirm it.
      if (!meta || peerId !== meta.host_peer_id || meta.status !== "playing") this.sendError(socket, "not_host_or_recruiting");
      return;
    }
    const members = await this.state.getMembers();
    const connected = members.filter((member) => member.connected);
    const unconnected = members.filter((member) => !member.connected);
    const now = Date.now();
    const playId = crypto.randomUUID();
    const participants = connected.map((member) => ({ peerId: member.peer_id, name: member.username, serverDomain: member.server_domain,
      selectedDifficulty: member.selected_difficulty, level: member.level, bpm: member.bpm, designer: member.designer }));
    await this.state.updateMetaTransition({ status: "playing", playId, startedAt: now });
    await this.seedPlayScores();
    try {
      await this.deps.persist.startPlay({ playId, roomId: meta.id, pool: meta.pool, songJson: meta.song_json,
        chartsJson: meta.charts_json, participantsJson: json(participants), startedAt: now, playerCount: connected.length, now });
    } catch (cause) {
      await this.state.updateMetaTransition({ status: "recruiting", playId: null, startedAt: null });
      throw cause;
    }
    for (const member of unconnected) await this.state.deleteMember(member.peer_id);
    this.broadcast({ type: "playStarted", playId });
    await this.notifySpectators();
    this.deps.directory.notify(meta.pool);
  }

  private async endPlay(reason: string): Promise<void> {
    const meta = await this.state.getMeta();
    if (!meta || meta.status !== "playing" || !meta.play_id) return;
    const now = Date.now();
    const cancelled = meta.started_at !== null && now < meta.started_at;
    // Freeze the last reported live scores into the play history.
    const scoreByPeer = new Map((await this.state.getScores()).map((row) => [row.peer_id, row]));
    let participants: Array<Record<string, unknown>> = [];
    try {
      participants = JSON.parse(await this.deps.persist.playParticipantsJson(meta.play_id) ?? "[]") as Array<Record<string, unknown>>;
    } catch { participants = []; }
    participants = participants.map((participant) => {
      const score = scoreByPeer.get(Number(participant.peerId));
      const play = parsePlayJson(score?.play_json ?? null);
      const merged: Record<string, unknown> = { ...participant, serverDomain: "anonymous" };
      if (play) {
        for (const key of ["techScore", "battleScore", "bulletHitCount", "playStatus"]) {
          if (play[key] !== undefined) merged[key] = play[key];
        }
      }
      return merged;
    });
    await this.deps.persist.finishPlay({ playId: meta.play_id, roomId: meta.id, cancelled, reason, participantsJson: json(participants), now });
    if ((await this.state.getMeta())?.status !== "playing") return;
    await this.state.updateMetaTransition({ status: "recruiting", playId: null, startedAt: null });
    await this.state.clearReady();
    await this.state.clearScores();
    this.broadcast({ type: cancelled ? "playCancelled" : "playEnded", playId: meta.play_id, reason });
    await this.notifySpectators();
    this.deps.directory.notify(meta.pool);
    if ((await this.state.getMembers()).length < 4) await this.deps.pools.markOpen(meta.coordinator, meta.id);
  }

  async onClose(socket: RoomSocket, reason: string): Promise<void> {
    await this.removeSocket(socket, reason);
  }

  private async removeSocket(socket: RoomSocket, reason: string): Promise<void> {
    const attachment = socket.data;
    if (attachment.spectator) return;
    const meta = await this.state.getMeta();
    if (!meta || meta.status === "closing" || meta.status === "closed") return;
    const member = await this.state.getMember(attachment.peerId);
    if (!member || member.identity_id !== attachment.identityId) return;
    // Preserve the seat in live state until its durable removal commits. A
    // failed close event can then be retried by a later close or the room alarm
    // instead of leaving a persistent connected ghost with no live member.
    await this.state.markDisconnected(attachment.peerId);
    await this.deps.scheduleAlarm(Date.now() + DISCONNECT_RETRY_MS);
    if (attachment.peerId === meta.host_peer_id) {
      await this.closeRoom("host_disconnect");
      return;
    }
    // A non-host drop mid-play keeps the player visible as "Disconnect" with frozen
    // scores; the native play cannot continue without its host, so a host drop closes.
    if (meta.status === "playing") {
      await this.markPlayScoreDropped(attachment.peerId, member.username);
      const count = (await this.state.getMembers()).filter((candidate) => candidate.peer_id !== attachment.peerId).length;
      await this.deps.persist.removeMemberPlaying(meta.id, attachment.peerId, count, Date.now());
      await this.state.deleteMember(attachment.peerId);
      this.broadcast({ type: "peerLeft", peerId: attachment.peerId, reason });
      await this.notifySpectators();
      this.deps.directory.notify(meta.pool);
      return;
    }
    await this.deps.persist.removeMember(meta.id, attachment.peerId);
    await this.state.deleteMember(attachment.peerId);
    const count = (await this.state.getMembers()).length;
    await this.deps.persist.updatePlayerCount(meta.id, count, Date.now());
    this.broadcast({ type: "peerLeft", peerId: attachment.peerId, reason });
    this.deps.directory.notify(meta.pool);
    if (count === 0) await this.closeRoom("empty");
    else if (meta.status === "recruiting") await this.deps.pools.markOpen(meta.coordinator, meta.id);
  }

  /** Called by the admin surface after selecting a room from the directory. */
  async forceClose(): Promise<boolean> {
    return this.closeRoom("admin_closed");
  }

  /** Removes an identity from this room immediately, including an unconnected reservation. */
  async banPlayer(identityId: string): Promise<boolean> {
    const meta = await this.state.getMeta();
    if (!meta || (meta.status !== "recruiting" && meta.status !== "playing")) return false;
    const member = (await this.state.getMembers()).find((candidate) => candidate.identity_id === identityId);
    if (!member) return false;
    if (member.peer_id === meta.host_peer_id)
      return this.closeRoom("player_banned");
    const currentMeta = await this.state.getMeta();
    const current = (await this.state.getMembers()).find((candidate) => candidate.identity_id === identityId);
    if (!currentMeta || (currentMeta.status !== "recruiting" && currentMeta.status !== "playing") || !current) return false;
    const count = (await this.state.getMembers()).length - 1;
    await this.deps.persist.banRemoveMember({ roomId: currentMeta.id, peerId: current.peer_id, identityId, playerCount: count, now: Date.now() });
    await this.state.deleteMemberByIdentity(current.peer_id, identityId);
    this.broadcast({ type: "peerLeft", peerId: current.peer_id, reason: "player_banned" });
    if (currentMeta.status === "playing") {
      await this.markPlayScoreDropped(current.peer_id, current.username);
      await this.notifySpectators();
    }
    this.deps.delivery.closePeer(current.peer_id, identityId, 1008, "Player banned");
    this.deps.directory.notify(currentMeta.pool);
    if (currentMeta.status === "recruiting") {
      try { await this.deps.pools.markOpen(currentMeta.coordinator, currentMeta.id); }
      catch { console.warn("Pool availability update failed"); }
    }
    return true;
  }

  private async closeRoom(reason: string): Promise<boolean> {
    const meta = await this.state.getMeta();
    if (!meta || meta.status === "closing" || meta.status === "closed") return false;
    const now = Date.now();
    await this.state.updateMetaStatus("closing");
    try {
      await this.deps.persist.closeRoomPersist({ roomId: meta.id, reason, now,
        play: meta.play_id ? { id: meta.play_id, cancelled: meta.started_at !== null && now < meta.started_at } : null });
    } catch (cause) {
      await this.state.updateMetaStatus(meta.status);
      await this.deps.scheduleAlarm(Date.now() + 5000);
      throw cause;
    }
    await this.state.updateMetaTransition({ status: "closed", playId: null, startedAt: null });
    await this.state.markDisconnectedReset();
    await this.state.clearScores();
    this.broadcast({ type: "roomClosing", reason });
    await this.notifySpectators();
    this.deps.directory.notify(meta.pool);
    this.deps.delivery.closeAll(1000, reason);
    try { await this.deps.pools.markClosed(meta.coordinator, meta.id); }
    catch { console.warn("Pool closure update failed"); }
    return true;
  }

  /** Returns false when the live state has expired and runtime-specific durable
   *  recovery must close the persistent projection by room id. */
  async alarm(): Promise<boolean> {
    const members = await this.state.getMembers();
    const meta = await this.state.getMeta();
    if (!meta) return false;
    if (meta.status === "closed") return true;
    const now = Date.now();
    const host = members.find((member) => member.peer_id === meta.host_peer_id);
    if (!host || !host.connected) {
      await this.closeRoom("host_disconnect");
      return true;
    }
    const stale = members.filter((member) => !member.connected &&
      (member.reserved_at === 0 || now - member.reserved_at > RESERVATION_TIMEOUT_MS));
    const remainingCount = members.length - stale.length;
    for (const member of stale) {
      if (meta.status === "playing") {
        if (member.reserved_at === 0) await this.markPlayScoreDropped(member.peer_id, member.username);
        await this.deps.persist.removeMemberPlaying(meta.id, member.peer_id, remainingCount, now);
      } else await this.deps.persist.removeMember(meta.id, member.peer_id);
      await this.state.deleteMember(member.peer_id);
      this.broadcast({ type: "peerLeft", peerId: member.peer_id,
        reason: member.reserved_at === 0 ? "disconnect" : "reservation_timeout" });
    }
    await this.deps.persist.updatePlayerCount(meta.id, (await this.state.getMembers()).length, now);
    this.deps.directory.notify(meta.pool);
    if ((await this.state.getMembers()).length === 0) await this.closeRoom("reservation_timeout");
    else {
      // The self-hosted live room is leased in Redis. An active alarm is real
      // liveness work, so renew the lease before scheduling its next check.
      await this.state.touchActive();
      if ((await this.state.getMembers()).some((member) => !member.connected))
        await this.deps.scheduleAlarm(now + RESERVATION_TIMEOUT_MS);
      else await this.deps.scheduleAlarm(now + ACTIVE_ROOM_ALARM_MS);
    }
    return true;
  }
}

function parsePlayJson(raw: string | null | undefined): Record<string, unknown> | null {
  let play: Record<string, unknown> | null = null;
  try { play = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { play = null; }
  return play;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
