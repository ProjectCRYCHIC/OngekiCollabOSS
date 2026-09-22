import type Redis from "ioredis";
import type { RoomStateStore } from "../../../core/rooms/state-store.js";
import type { MetaRow, MemberRow, PlayScoreRow } from "../../../core/rooms/types.js";

/** Ephemeral room keys expire on their own; rooms are transient state and the
 *  durable record lives in MySQL. Six hours comfortably exceeds any session. */
const ROOM_KEY_TTL_SECONDS = 6 * 60 * 60;
const NULL_SENTINEL = "\u0000";

const metaKey = (roomId: string) => `room:${roomId}:meta`;
const membersKey = (roomId: string) => `room:${roomId}:members`;
const scoresKey = (roomId: string) => `room:${roomId}:scores`;

function metaFromRedis(raw: Record<string, string>): MetaRow | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    coordinator: raw.coordinator,
    pool: raw.pool,
    game_version: raw.game_version,
    song_json: raw.song_json,
    charts_json: raw.charts_json,
    status: raw.status,
    host_peer_id: Number(raw.host_peer_id),
    play_id: raw.play_id === NULL_SENTINEL ? null : raw.play_id,
    started_at: raw.started_at === NULL_SENTINEL ? null : Number(raw.started_at),
    created_at: Number(raw.created_at),
  };
}

function metaToRedis(meta: MetaRow): Record<string, string> {
  return {
    id: meta.id,
    coordinator: meta.coordinator,
    pool: meta.pool,
    game_version: meta.game_version,
    song_json: meta.song_json,
    charts_json: meta.charts_json,
    status: meta.status,
    host_peer_id: String(meta.host_peer_id),
    play_id: meta.play_id ?? NULL_SENTINEL,
    started_at: meta.started_at === null ? NULL_SENTINEL : String(meta.started_at),
    created_at: String(meta.created_at),
  };
}

async function touch(redis: Redis, ...keys: string[]): Promise<void> {
  for (const key of keys) await redis.expire(key, ROOM_KEY_TTL_SECONDS);
}

function membersFromRedis(raw: Record<string, string>): MemberRow[] {
  const rows = Object.entries(raw).map(([peerId, value]) => JSON.parse(value) as MemberRow);
  rows.sort((a, b) => a.peer_id - b.peer_id);
  return rows;
}

/** Redis implementation of the authoritative live room state. Every mutation
 *  runs under the per-room lock held by the room service, mirroring the Durable
 *  Object's single-threaded serialization. */
export function createRedisRoomState(redis: Redis, roomId: string): RoomStateStore {
  const mKey = metaKey(roomId);
  const memKey = membersKey(roomId);
  const sKey = scoresKey(roomId);

  const getMember = async (peerId: number): Promise<MemberRow | null> => {
    const raw = await redis.hget(memKey, String(peerId));
    return raw ? JSON.parse(raw) as MemberRow : null;
  };
  const putMember = async (member: MemberRow): Promise<void> => {
    await redis.hset(memKey, String(member.peer_id), JSON.stringify(member));
    await touch(redis, memKey);
  };

  return {
    async getMeta() {
      return metaFromRedis(await redis.hgetall(mKey));
    },
    async insertMeta(meta) {
      await redis.hset(mKey, metaToRedis(meta));
      await touch(redis, mKey);
    },
    async deleteMeta() {
      await redis.del(mKey);
    },
    async updateMetaStatus(status) {
      await redis.hset(mKey, "status", status);
      await touch(redis, mKey);
    },
    async updateMetaTransition({ status, playId, startedAt }) {
      await redis.hset(mKey, "status", status, "play_id", playId ?? NULL_SENTINEL, "started_at", startedAt === null ? NULL_SENTINEL : String(startedAt));
      await touch(redis, mKey);
    },
    async touchActive() {
      await touch(redis, mKey, memKey, sKey);
    },

    async getMembers() {
      return membersFromRedis(await redis.hgetall(memKey));
    },
    async getMember(peerId) {
      return getMember(peerId);
    },
    async getConnectedMember(peerId, identityId) {
      const member = await getMember(peerId);
      return member && member.identity_id === identityId && member.connected === 1 ? member : null;
    },
    async rereserve(peerId, reservationId, now) {
      const member = await getMember(peerId);
      if (!member) return;
      member.reservation_id = reservationId;
      member.reserved_at = now;
      await putMember(member);
    },
    async insertMember(member) {
      await putMember(member);
    },
    async deleteMember(peerId) {
      await redis.hdel(memKey, String(peerId));
      await touch(redis, memKey);
    },
    async deleteMemberByIdentity(peerId, identityId) {
      const member = await getMember(peerId);
      if (member?.identity_id === identityId) await redis.hdel(memKey, String(peerId));
    },
    async markConnected(peerId) {
      const member = await getMember(peerId);
      if (!member) return;
      member.connected = 1;
      await putMember(member);
    },
    async markDisconnected(peerId) {
      const member = await getMember(peerId);
      if (!member) return;
      member.connected = 0;
      member.reserved_at = 0;
      await putMember(member);
    },
    async markDisconnectedReset() {
      for (const member of await this.getMembers()) {
        member.connected = 0;
        member.ready_json = null;
        await putMember(member);
      }
    },
    async clearReady() {
      for (const member of await this.getMembers()) {
        member.ready_json = null;
        member.rtt_ms = 0;
        await putMember(member);
      }
    },
    async clearMemberReady(peerId) {
      const member = await getMember(peerId);
      if (!member) return;
      member.ready_json = null;
      member.rtt_ms = 0;
      await putMember(member);
    },
    async updateReady(peerId, readyJson, selectedDifficulty, level, bpm, designer, rttMs) {
      const member = await getMember(peerId);
      if (!member) return;
      member.ready_json = readyJson;
      member.selected_difficulty = selectedDifficulty;
      member.level = level;
      member.bpm = bpm;
      member.designer = designer;
      member.rtt_ms = rttMs;
      await putMember(member);
    },

    async getScores(): Promise<PlayScoreRow[]> {
      const raw = await redis.hgetall(sKey);
      return Object.entries(raw).map(([peerId, value]) => JSON.parse(value) as PlayScoreRow);
    },
    async seedScore(peerId, name) {
      await redis.hsetnx(sKey, String(peerId), JSON.stringify({ peer_id: peerId, name, play_json: null, disconnected_at: null } satisfies PlayScoreRow));
      await touch(redis, sKey);
    },
    async upsertScore(peerId, name, playJson) {
      await redis.hset(sKey, String(peerId), JSON.stringify({ peer_id: peerId, name, play_json: playJson, disconnected_at: null } satisfies PlayScoreRow));
      await touch(redis, sKey);
    },
    async markScoreDropped(peerId, name, now) {
      const existing = await redis.hget(sKey, String(peerId));
      const previous = existing ? JSON.parse(existing) as PlayScoreRow : null;
      await redis.hset(sKey, String(peerId), JSON.stringify({ peer_id: peerId, name, play_json: previous?.play_json ?? null, disconnected_at: now } satisfies PlayScoreRow));
      await touch(redis, sKey);
    },
    async clearScores() {
      await redis.del(sKey);
    },
  };
}
