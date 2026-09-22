import { describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import { RedisScheduler } from "../src/adapters/realtime/redis/scheduler.js";
import { RoomEngine } from "../src/core/rooms/engine.js";
import { MAX_CONTROL_MESSAGE_BYTES, utf8Size } from "../src/core/protocol.js";
import type { RoomEngineDeps, RoomSocket } from "../src/core/rooms/engine.js";
import type { RoomPersistence } from "../src/core/rooms/persistence.js";
import type { RoomStateStore } from "../src/core/rooms/state-store.js";
import type { MemberRow, MetaRow, PlayScoreRow } from "../src/core/rooms/types.js";
import { songSourceUrl } from "../frontend/src/board/songs.js";
import { difficultyLabel, relativeLevelLabel } from "../frontend/src/board/types.js";

function song(id = 1000) {
  return { id, title: `Song ${id}`, artist: "Artist", genre: "ORIGINAL", version: "1.50",
    selectedDifficulty: 3, level: 13.7, bpm: 180, designer: "Designer",
    charts: [{ difficulty: 3, sha256: "a".repeat(64) }] };
}

class MemoryState implements RoomStateStore {
  meta: MetaRow | null = null;
  members: MemberRow[] = [];
  scores: PlayScoreRow[] = [];
  async getMeta() { return this.meta; }
  async insertMeta(meta: MetaRow) { this.meta = { ...meta }; }
  async deleteMeta() { this.meta = null; }
  async updateMetaStatus(status: string) { if (this.meta) this.meta.status = status; }
  async updateMetaTransition(input: { status: string; playId: string | null; startedAt: number | null }) {
    if (this.meta) Object.assign(this.meta, { status: input.status, play_id: input.playId, started_at: input.startedAt });
  }
  async touchActive() {}
  async getMembers() { return this.members.map((member) => ({ ...member })); }
  async getMember(peerId: number) { return this.members.find((member) => member.peer_id === peerId) ?? null; }
  async getConnectedMember(peerId: number, identityId: string) {
    return this.members.find((member) => member.peer_id === peerId && member.identity_id === identityId && member.connected === 1) ?? null;
  }
  async rereserve(peerId: number, reservationId: string, now: number) {
    const member = await this.getMember(peerId); if (member) Object.assign(member, { reservation_id: reservationId, reserved_at: now });
  }
  async insertMember(member: MemberRow) { this.members.push({ ...member }); }
  async deleteMember(peerId: number) { this.members = this.members.filter((member) => member.peer_id !== peerId); }
  async deleteMemberByIdentity(peerId: number, identityId: string) {
    this.members = this.members.filter((member) => member.peer_id !== peerId || member.identity_id !== identityId);
  }
  async markConnected(peerId: number) { const member = await this.getMember(peerId); if (member) member.connected = 1; }
  async markDisconnected(peerId: number) {
    const member = await this.getMember(peerId); if (member) Object.assign(member, { connected: 0, reserved_at: 0 });
  }
  async markDisconnectedReset() { for (const member of this.members) Object.assign(member, { connected: 0, ready_json: null }); }
  async clearReady() { for (const member of this.members) Object.assign(member, { ready_json: null, rtt_ms: 0 }); }
  async clearMemberReady(peerId: number) {
    const found = await this.getMember(peerId); if (found) Object.assign(found, { ready_json: null, rtt_ms: 0 });
  }
  async updateReady(peerId: number, readyJson: string, selectedDifficulty: number, level: number, bpm: number, designer: string, rttMs: number) {
    const member = await this.getMember(peerId);
    if (member) Object.assign(member, { ready_json: readyJson, selected_difficulty: selectedDifficulty, level, bpm, designer, rtt_ms: rttMs });
  }
  async getScores() { return this.scores.map((score) => ({ ...score })); }
  async seedScore(peerId: number, name: string) {
    if (!this.scores.some((score) => score.peer_id === peerId)) this.scores.push({ peer_id: peerId, name, play_json: null, disconnected_at: null });
  }
  async upsertScore(peerId: number, name: string, playJson: string) {
    this.scores = this.scores.filter((score) => score.peer_id !== peerId);
    this.scores.push({ peer_id: peerId, name, play_json: playJson, disconnected_at: null });
  }
  async markScoreDropped(peerId: number, name: string, now: number) {
    const existing = this.scores.find((score) => score.peer_id === peerId);
    if (existing) existing.disconnected_at = now;
    else this.scores.push({ peer_id: peerId, name, play_json: null, disconnected_at: now });
  }
  async clearScores() { this.scores = []; }
}

function persistence(overrides: Partial<RoomPersistence> = {}): RoomPersistence {
  const noop = async () => undefined;
  return {
    createRoom: noop, reserveSeat: noop, markConnected: noop, updateReady: noop, startPlay: noop,
    playParticipantsJson: async () => null, finishPlay: noop, removeMemberPlaying: noop,
    removeMember: noop, updatePlayerCount: noop, banRemoveMember: noop, closeRoomPersist: noop,
    recoverExpiredRoom: async () => null,
    ...overrides,
  };
}

function member(peerId: number, connected = 1): MemberRow {
  return { peer_id: peerId, identity_id: `player-${peerId}`, reservation_id: `reservation-${peerId}`,
    username: `Player ${peerId}`, card_id: 1000 + peerId, server_domain: "anonymous", selected_difficulty: 3, level: 13.7,
    bpm: 180, designer: "Designer", connected, ready_json: null, rtt_ms: 0, reserved_at: Date.now() - 120_000 };
}

function meta(status = "recruiting"): MetaRow {
  return { id: crypto.randomUUID(), coordinator: "pool", pool: "test", game_version: "1.50.1",
    song_json: JSON.stringify(song()), charts_json: JSON.stringify(song().charts), status,
    host_peer_id: 1, play_id: null, started_at: null, created_at: Date.now() };
}

function fixture(state: MemoryState, persist: RoomPersistence) {
  const alarms: number[] = [];
  const broadcasts: Array<{ text: string; exceptPeerId?: number }> = [];
  const deps: RoomEngineDeps = {
    state, persist,
    pools: { markOpen: async () => undefined, markClosed: async () => undefined },
    directory: { notify: () => undefined },
    registry: { sockets: () => [] },
    delivery: { broadcastText: (text, exceptPeerId) => { broadcasts.push({ text, exceptPeerId }); },
      forwardFrame: () => undefined, notifySpectators: () => undefined,
      closePeer: () => undefined, closeAll: () => undefined },
    scheduleAlarm: (at) => { alarms.push(at); },
  };
  return { engine: new RoomEngine(deps), alarms, broadcasts };
}

describe("RoomEngine failure compensation", () => {
  it("disconnects and schedules cleanup when the initial room snapshot cannot be sent", async () => {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1, 0)];
    const persist = persistence({ markConnected: vi.fn(async () => undefined) });
    const { engine, alarms } = fixture(state, persist);
    const socket = { data: { peerId: 1, identityId: "player-1", messages: 0, windowStart: Date.now() },
      send: vi.fn(() => { throw new Error("socket closed during upgrade"); }), sendBinary: vi.fn(),
      close: vi.fn(), save: vi.fn() } satisfies RoomSocket;
    const ticket = { type: "room" as const, roomId: state.meta.id, identityId: "player-1", peerId: 1,
      reservationId: "reservation-1", pool: state.meta.pool, exp: Date.now() + 60_000 };

    await expect(engine.completePlayerConnection(socket, ticket, state.meta)).rejects.toThrow("socket closed during upgrade");
    expect(await state.getMember(1)).toMatchObject({ connected: 0, reserved_at: 0 });
    expect(alarms).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledWith(1011, "Room join failed");
  });

  it("keeps a disconnected guest retryable when durable removal fails", async () => {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1), member(2)];
    const removeMember = vi.fn<RoomPersistence["removeMember"]>()
      .mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(undefined);
    const persist = persistence({ removeMember, updatePlayerCount: vi.fn(async () => undefined) });
    const { engine, alarms } = fixture(state, persist);
    const socket = { data: { peerId: 2, identityId: "player-2", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn() } satisfies RoomSocket;

    await expect(engine.onClose(socket, "disconnect")).rejects.toThrow("database unavailable");
    expect(await state.getMember(2)).toMatchObject({ connected: 0, reserved_at: 0 });
    expect(alarms.length).toBeGreaterThan(0);

    await expect(engine.alarm()).resolves.toBe(true);
    expect(await state.getMember(2)).toBeNull();
    expect(removeMember).toHaveBeenCalledTimes(2);
  });

  it("renews the active live-state lease before scheduling the next alarm", async () => {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1)];
    state.touchActive = vi.fn(async () => undefined);
    const { engine, alarms } = fixture(state, persistence({ updatePlayerCount: vi.fn(async () => undefined) }));
    await expect(engine.alarm()).resolves.toBe(true);
    expect(state.touchActive).toHaveBeenCalledOnce();
    expect(alarms).toHaveLength(1);
  });

  it("closes an initialized room whose creator seat was never reserved", async () => {
    const state = new MemoryState();
    const closeRoomPersist = vi.fn(async () => undefined);
    const { engine, alarms } = fixture(state, persistence({ closeRoomPersist }));
    await engine.initialize({ id: crypto.randomUUID(), coordinator: "pool", request: {
      protocolVersion: 1, pool: "test", gameVersion: "1.50.1", username: "Host", song: song(), roomId: null,
    } });
    expect(alarms).toHaveLength(1);
    await expect(engine.alarm()).resolves.toBe(true);
    expect(state.meta?.status).toBe("closed");
    expect(closeRoomPersist).toHaveBeenCalledOnce();
  });
});

describe("RoomEngine player profile events", () => {
  it("publishes only the reserved seat's bounded display profile", async () => {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1)];
    const { engine, broadcasts } = fixture(state, persistence());

    await engine.reserve({ identityId: "player-2", username: "Guest", cardId: 2042,
      serverDomain: "member.example.test", song: song() });

    const joined = JSON.parse(broadcasts.at(-1)!.text) as Record<string, unknown>;
    expect(joined).toEqual({ type: "peerJoined", peerId: 2, name: "Guest", cardId: 2042 });
    expect(JSON.stringify(joined)).not.toContain("member.example.test");
  });

  it("repeats the display profile when a reserved peer connects", async () => {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1), { ...member(2, 0), username: "Guest", card_id: 2042 }];
    const { engine, broadcasts } = fixture(state, persistence());
    const socket = { data: { peerId: 2, identityId: "player-2", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn() } satisfies RoomSocket;
    const ticket = { type: "room" as const, roomId: state.meta.id, identityId: "player-2", peerId: 2,
      reservationId: "reservation-2", pool: state.meta.pool, exp: Date.now() + 60_000 };

    await engine.completePlayerConnection(socket, ticket, state.meta);

    expect(JSON.parse(broadcasts.at(-1)!.text)).toEqual({
      type: "peerConnected", peerId: 2, name: "Guest", cardId: 2042,
    });
    expect(broadcasts.at(-1)!.exceptPeerId).toBe(2);
  });
});

describe("RoomEngine ready reset", () => {
  it("clears only the member that returned to settings", async () => {
    const state = new MemoryState();
    state.meta = meta();
    const readyJson = JSON.stringify(song());
    state.members = [
      { ...member(1), ready_json: readyJson, rtt_ms: 30 },
      { ...member(2), ready_json: readyJson, rtt_ms: 40 },
    ];
    const { engine } = fixture(state, persistence());
    const socket = {
      data: { peerId: 2, identityId: "player-2", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn(),
    } satisfies RoomSocket;

    await engine.onMessage(socket, JSON.stringify({ type: "unready" }));

    expect(await state.getMember(1)).toMatchObject({ ready_json: readyJson, rtt_ms: 30 });
    expect(await state.getMember(2)).toMatchObject({ ready_json: null, rtt_ms: 0 });
  });
});

describe("RoomEngine control-message boundary", () => {
  function setup() {
    const state = new MemoryState();
    state.meta = meta();
    state.members = [member(1)];
    const { engine } = fixture(state, persistence());
    const socket = {
      data: { peerId: 1, identityId: "player-1", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn(),
    } satisfies RoomSocket;
    return { engine, socket };
  }

  it("accepts a control message of exactly 16384 UTF-8 bytes", async () => {
    const { engine, socket } = setup();
    const prefix = '{"type":"unknown","padding":"';
    const suffix = '"}';
    const exact = prefix + "x".repeat(MAX_CONTROL_MESSAGE_BYTES - utf8Size(prefix + suffix)) + suffix;

    expect(utf8Size(exact)).toBe(MAX_CONTROL_MESSAGE_BYTES);
    await engine.onMessage(socket, exact);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "error", code: "unknown_control" }));
  });

  it("rejects a control message of exactly 16385 UTF-8 bytes", async () => {
    const { engine, socket } = setup();
    const prefix = '{"type":"unknown","padding":"';
    const suffix = '"}';
    const oversized = prefix + "x".repeat(MAX_CONTROL_MESSAGE_BYTES + 1 - utf8Size(prefix + suffix)) + suffix;

    expect(utf8Size(oversized)).toBe(MAX_CONTROL_MESSAGE_BYTES + 1);
    await engine.onMessage(socket, oversized);
    expect(socket.close).toHaveBeenCalledWith(1009, "Message too large");
  });

  it("measures multibyte control messages by UTF-8 bytes instead of JavaScript characters", async () => {
    const { engine, socket } = setup();
    const prefix = '{"type":"unknown","padding":"';
    const suffix = '"}';

    const multibyte = prefix + "界".repeat(6000) + suffix;
    expect(multibyte.length).toBeLessThan(MAX_CONTROL_MESSAGE_BYTES);
    expect(utf8Size(multibyte)).toBeGreaterThan(MAX_CONTROL_MESSAGE_BYTES);
    await engine.onMessage(socket, multibyte);
    expect(socket.close).toHaveBeenCalledWith(1009, "Message too large");
  });
});

describe("RoomEngine player score recovery", () => {
  it("echoes each validated live score to the other room members", async () => {
    const state = new MemoryState();
    state.meta = meta("playing");
    state.members = [member(1), member(2)];
    const { engine, broadcasts } = fixture(state, persistence());
    const socket = {
      data: { peerId: 2, identityId: "player-2", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn(),
    } satisfies RoomSocket;

    await engine.onMessage(socket, JSON.stringify({ type: "score", techScore: 987654,
      battleScore: 1234, bulletHitCount: 567, playStatus: "Win" }));

    expect(JSON.parse(state.scores[0].play_json!)).toEqual({ techScore: 987654,
      battleScore: 1234, bulletHitCount: 567, playStatus: "Win" });
    expect(broadcasts).toContainEqual({ exceptPeerId: 2, text: JSON.stringify({
      type: "scoreState", peerId: 2, techScore: 987654, battleScore: 1234,
      bulletHitCount: 567, playStatus: "Win",
    }) });
  });

  it("merges a partial score into the stored play while broadcasting only the delta", async () => {
    const state = new MemoryState();
    state.meta = meta("playing");
    state.members = [member(1), member(2)];
    const { engine, broadcasts } = fixture(state, persistence());
    const socket = {
      data: { peerId: 2, identityId: "player-2", messages: 0, windowStart: Date.now() },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn(),
    } satisfies RoomSocket;

    await engine.onMessage(socket, JSON.stringify({ type: "score", techScore: 900000,
      battleScore: 1234, bulletHitCount: 567, playStatus: "Playing" }));
    await engine.onMessage(socket, JSON.stringify({ type: "score", techScore: 987654 }));

    expect(state.scores).toHaveLength(1);
    expect(JSON.parse(state.scores[0].play_json!)).toEqual({ techScore: 987654,
      battleScore: 1234, bulletHitCount: 567, playStatus: "Playing" });
    expect(JSON.parse(broadcasts.at(-1)!.text)).toEqual({
      type: "scoreState", peerId: 2, techScore: 987654,
    });
    expect(broadcasts.at(-1)!.exceptPeerId).toBe(2);
  });

  it("projects absent live-score fields as null instead of zero", async () => {
    const state = new MemoryState();
    state.meta = meta("playing");
    state.members = [member(1)];
    state.scores = [{ peer_id: 1, name: "Player 1", play_json: null, disconnected_at: null }];
    const { engine } = fixture(state, persistence());
    const spectator = {
      data: { peerId: 0, identityId: "", messages: 0, windowStart: Date.now(), spectator: true },
      send: vi.fn(), sendBinary: vi.fn(), close: vi.fn(), save: vi.fn(),
    } satisfies RoomSocket;

    await engine.addSpectator(spectator, state.meta);

    const payload = JSON.parse(String(spectator.send.mock.calls[0][0]));
    expect(payload.players[0]).toMatchObject({
      techScore: null, battleScore: null, bulletHitCount: null, playStatus: null,
    });
  });
});

describe("board song metadata", () => {
  it("links a title through the arcade-songs id query", () => {
    expect(songSourceUrl("星空 / Test?"))
      .toBe("https://arcade-songs.zetaraku.dev/ongeki/song/?id=%E6%98%9F%E7%A9%BA%20%2F%20Test%3F");
  });

  it("shows relative chart levels without exposing exact constants", () => {
    expect(relativeLevelLabel(12.0)).toBe("12");
    expect(relativeLevelLabel(12.6)).toBe("12");
    expect(relativeLevelLabel(12.7)).toBe("12+");
    expect(relativeLevelLabel(12.9)).toBe("12+");
    expect(relativeLevelLabel(13.0)).toBe("13");
    expect(relativeLevelLabel("13.9")).toBe("13+");
    expect(relativeLevelLabel("14+")).toBe("14+");
    expect(relativeLevelLabel(null)).toBe("—");
    expect(difficultyLabel(3, 12.7)).toBe("MASTER Lv 12+");
  });
});

describe("RedisScheduler failure compensation", () => {
  it("requeues a failed room alarm with backoff and clears retry state after success", async () => {
    const raw = JSON.stringify({ kind: "room-alarm", roomId: "room-1" });
    const redis = {
      eval: vi.fn().mockResolvedValue([raw]),
      hincrby: vi.fn().mockResolvedValue(1),
      zadd: vi.fn().mockResolvedValue(1),
      hdel: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;
    const onRoomAlarm = vi.fn().mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue(undefined);
    const scheduler = new RedisScheduler(redis, onRoomAlarm, { purge: async () => undefined });
    const poll = () => (scheduler as unknown as { poll(): Promise<void> }).poll();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await poll();
      expect(redis.hincrby).toHaveBeenCalledWith("collab:job-retries", "room-1", 1);
      expect(redis.zadd).toHaveBeenCalledWith("collab:jobs", "LT", expect.any(String), raw);

      await poll();
      expect(onRoomAlarm).toHaveBeenCalledTimes(2);
      expect(redis.hdel).toHaveBeenCalledWith("collab:job-retries", "room-1");
    } finally {
      warning.mockRestore();
    }
  });
});
