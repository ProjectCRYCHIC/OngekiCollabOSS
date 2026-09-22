import type { Pool as MySQLPool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { UniqueConstraintError } from "../../../core/ports.js";
import type {
  AdminQueries, ChallengeRepository, CleanupStore, CursorPage, DirectoryQueries, HealthService,
  IdentityRepository, PagedRows, PageInput, PlayerControlRepository, RoomQueryRepository,
  SettingsRepository,
} from "../../../core/ports.js";
import type {
  ChallengeRow, IdentityBinding, IdentityRow, PlayHistoryRow, PlayerControlRow, RoomAdminRow,
  RoomCoreRow, RoomDirectoryRow, RoomMemberAdminRow, RoomMemberPublicRow,
} from "../../../core/ports.js";
import type { IdentityHashes } from "../../../core/ports.js";
import type { RoomPersistence } from "../../../core/rooms/persistence.js";
import type { SelfhostDataStores } from "../selfhost.js";

export type MysqlDataStores = SelfhostDataStores;

type Row = RowDataPacket;

type Conn = MySQLPool | PoolConnection;

/** Minimal structural view of mysql2's query surface; the library's exported
 *  Pool/Connection unions resolve inconsistently under bundler resolution. */
interface SqlRunner {
  query<T>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
}

const runner = (conn: Conn): SqlRunner => conn as unknown as SqlRunner;

async function select<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await runner(conn).query<Row[]>(sql, params);
  return rows as unknown as T[];
}

async function selectFirst<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await select<T>(conn, sql, params);
  return rows[0] ?? null;
}

async function exec(conn: Conn, sql: string, params: unknown[] = []): Promise<number> {
  const [result] = await runner(conn).query<ResultSetHeader>(sql, params);
  return result.affectedRows;
}

async function tx<T>(pool: MySQLPool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (cause) {
    try { await conn.rollback(); } catch { /* connection already broken */ }
    throw cause;
  } finally {
    conn.release();
  }
}

function isDuplicateEntry(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && (cause as { code?: string }).code === "ER_DUP_ENTRY");
}

export function createMysqlDataStores(pool: MySQLPool): MysqlDataStores {
  const identities: IdentityRepository = {
    async findBinding(hashes: IdentityHashes) {
      return selectFirst<IdentityBinding>(pool,
        "SELECT id, composite_hash, encrypted_key FROM identities WHERE composite_hash = ? OR keychip_hash = ? OR access_hash = ? OR user_hash = ?",
        [hashes.compositeHash, hashes.keychipHash, hashes.accessHash, hashes.userHash]);
    },
    async create({ id, hashes, encryptedKey, now }) {
      try {
        await exec(pool,
          "INSERT INTO identities(id,keychip_hash,access_hash,user_hash,server_hash,composite_hash,server_domain,encrypted_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [id, hashes.keychipHash, hashes.accessHash, hashes.userHash, hashes.serverHash,
            hashes.compositeHash, hashes.serverDomain, encryptedKey, now, now]);
      } catch (cause) {
        if (isDuplicateEntry(cause)) throw new UniqueConstraintError();
        throw cause;
      }
    },
    async exists(id) {
      return Boolean(await selectFirst<{ id: string }>(pool, "SELECT id FROM identities WHERE id = ?", [id]));
    },
    async findById(id) {
      return selectFirst<IdentityRow>(pool, "SELECT * FROM identities WHERE id = ?", [id]);
    },
    async findSessionIdentity(id) {
      return selectFirst<{ id: string; server_domain: string }>(pool, "SELECT id,server_domain FROM identities WHERE id = ?", [id]);
    },
    async migrateServerHash(identityId, hashes, previous, now) {
      const affected = await exec(pool,
        "UPDATE identities SET server_hash = ?, composite_hash = ?, updated_at = ? WHERE id = ? AND keychip_hash = ? AND access_hash = ? AND user_hash = ? AND server_hash = ? AND composite_hash = ?",
        [hashes.serverHash, hashes.compositeHash, now, identityId, previous.keychip_hash,
          previous.access_hash, previous.user_hash, previous.server_hash, previous.composite_hash]);
      return affected === 1;
    },
    async deleteWithChallenges(id) {
      await tx(pool, async (conn) => {
        await exec(conn, "DELETE FROM challenges WHERE identity_id = ?", [id]);
        await exec(conn, "DELETE FROM identities WHERE id = ?", [id]);
      });
    },
  };

  const challenges: ChallengeRepository = {
    async create({ id, identityId, nonce, expiresAt }) {
      await exec(pool, "INSERT INTO challenges(id,identity_id,nonce,expires_at) VALUES(?,?,?,?)",
        [id, identityId, nonce, expiresAt]);
    },
    async find(challengeId, identityId) {
      return selectFirst<ChallengeRow>(pool, "SELECT * FROM challenges WHERE id = ? AND identity_id = ?", [challengeId, identityId]);
    },
    async consume(challengeId, now) {
      const affected = await exec(pool, "UPDATE challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
        [now, challengeId, now]);
      return affected === 1;
    },
  };

  const playerControls: PlayerControlRepository = {
    async record(id, kind, username, serverDomain, now) {
      await exec(pool,
        "INSERT INTO player_controls(id,kind,username,server_domain,created_at,last_seen_at) VALUES(?,?,?,?,?,?) " +
        "ON DUPLICATE KEY UPDATE username = IF(VALUES(username) <> '', VALUES(username), username), server_domain = VALUES(server_domain), last_seen_at = VALUES(last_seen_at)",
        [id, kind, username, serverDomain, now, now]);
      const row = await selectFirst<{ banned_at: number | null }>(pool, "SELECT banned_at FROM player_controls WHERE id = ?", [id]);
      return row?.banned_at == null;
    },
    async ban(id, reason, now) {
      const affected = await exec(pool, "UPDATE player_controls SET banned_at = ?, ban_reason = ? WHERE id = ?", [now, reason, id]);
      return affected === 1;
    },
    async unban(id) {
      const affected = await exec(pool, "UPDATE player_controls SET banned_at = NULL, ban_reason = NULL WHERE id = ?", [id]);
      return affected === 1;
    },
    async bannedAt(id) {
      return selectFirst<{ banned_at: number | null }>(pool, "SELECT banned_at FROM player_controls WHERE id = ?", [id]);
    },
    async activeRoomIdsFor(identityId) {
      const rows = await select<{ room_id: string }>(pool,
        "SELECT DISTINCT room_id FROM room_members WHERE identity_id = ? AND room_id IN (SELECT id FROM rooms WHERE status IN ('recruiting','playing'))",
        [identityId]);
      return rows.map((row) => row.room_id);
    },
  };

  const roomQueries: RoomQueryRepository = {
    async findById(id): Promise<RoomCoreRow | null> {
      return selectFirst<RoomCoreRow>(pool, "SELECT id,pool,status,game_version,song_json FROM rooms WHERE id = ?", [id]);
    },
    async findOwnRecruitingHost(identityId, poolName) {
      return selectFirst<RoomCoreRow>(pool,
        "SELECT r.id,r.pool,r.status,r.game_version,r.song_json FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.identity_id = ? AND m.peer_id = 1 AND r.pool = ? AND r.status = 'recruiting' ORDER BY r.updated_at DESC LIMIT 1",
        [identityId, poolName]);
    },
  };

  const directoryQueries: DirectoryQueries = {
    async activeRoomRows(page: PageInput): Promise<PagedRows<RoomDirectoryRow>> {
      const rows = await select<RoomDirectoryRow>(pool,
        "SELECT id,pool,status,song_json,player_count,max_players,created_at,started_at,updated_at FROM rooms WHERE pool = ? AND status IN ('recruiting','playing') AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT " + (page.limit + 1),
        [page.pool, page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId]);
      return { rows, hasMore: rows.length > page.limit };
    },
    async memberRows(roomId): Promise<RoomMemberPublicRow[]> {
      return select<RoomMemberPublicRow>(pool,
        "SELECT peer_id,username,card_id,selected_difficulty,level,connected FROM room_members WHERE room_id = ? ORDER BY peer_id", [roomId]);
    },
    async historyRows(page: PageInput, endedAfter: number): Promise<PagedRows<PlayHistoryRow>> {
      const rows = await select<PlayHistoryRow>(pool,
        "SELECT id,room_id,pool,song_json,participants_json,started_at,ended_at,end_reason FROM plays WHERE pool = ? AND ended_at IS NOT NULL AND ended_at >= ? AND (? IS NULL OR ended_at < ? OR (ended_at = ? AND id < ?)) ORDER BY ended_at DESC,id DESC LIMIT " + (page.limit + 1),
        [page.pool, endedAfter, page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId]);
      return { rows, hasMore: rows.length > page.limit };
    },
  };

  const adminQueries: AdminQueries = {
    async playerRows(params): Promise<PagedRows<PlayerControlRow>> {
      const escaped = params.query.replace(/[\\%_]/g, "\\$&");
      const rows = await select<PlayerControlRow>(pool,
        // MySQL processes backslash escapes inside SQL string literals, so the
        // ESCAPE character must be written as '\\' here (SQLite needed '\').
        "SELECT * FROM player_controls WHERE (? = '' OR id = ? OR username LIKE ? ESCAPE '\\\\') AND (? IS NULL OR last_seen_at < ? OR (last_seen_at = ? AND id < ?)) ORDER BY last_seen_at DESC,id DESC LIMIT " + (params.limit + 1),
        [params.query, params.query, `%${escaped}%`, params.beforeTime, params.beforeTime, params.beforeTime, params.beforeId]);
      return { rows, hasMore: rows.length > params.limit };
    },
    async battleRows(page: CursorPage): Promise<PagedRows<RoomAdminRow>> {
      const rows = await select<RoomAdminRow>(pool,
        "SELECT id,pool,status,song_json,player_count,created_at,started_at,updated_at FROM rooms WHERE status IN ('recruiting','playing') AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT " + (page.limit + 1),
        [page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId]);
      return { rows, hasMore: rows.length > page.limit };
    },
    async battleMemberRows(roomId): Promise<RoomMemberAdminRow[]> {
      return select<RoomMemberAdminRow>(pool,
        "SELECT identity_id,username,server_domain FROM room_members WHERE room_id = ? ORDER BY peer_id", [roomId]);
    },
  };

  const settings: SettingsRepository = {
    async getIdentityRequired() {
      const row = await selectFirst<{ value: string; updated_at: number }>(pool,
        "SELECT `value`, updated_at FROM service_settings WHERE `key` = 'identity_required'");
      return { required: row?.value === "1", updatedAt: row?.updated_at ?? null };
    },
    async setIdentityRequired(required, now) {
      await exec(pool,
        "INSERT INTO service_settings(`key`,`value`,updated_at) VALUES('identity_required',?,?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
        [required ? "1" : "0", now]);
    },
    async getValue(key) {
      const row = await selectFirst<{ value: string; updated_at: number }>(pool,
        "SELECT `value`, updated_at FROM service_settings WHERE `key` = ?", [key]);
      return row ? { value: row.value, updatedAt: row.updated_at } : null;
    },
    async setValue(key, value, now) {
      await exec(pool,
        "INSERT INTO service_settings(`key`,`value`,updated_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
        [key, value, now]);
    },
  };

  const cleanup: CleanupStore = {
    async purge({ expiredBefore, playCutoff, anonymousCutoff }) {
      await tx(pool, async (conn) => {
        await exec(conn, "DELETE FROM challenges WHERE expires_at < ?", [expiredBefore]);
        await exec(conn, "DELETE FROM plays WHERE ended_at IS NOT NULL AND ended_at < ?", [playCutoff]);
        await exec(conn, "DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE status = 'closed' AND updated_at < ?)", [playCutoff]);
        await exec(conn, "DELETE FROM rooms WHERE status = 'closed' AND updated_at < ?", [playCutoff]);
        await exec(conn, "DELETE FROM player_controls WHERE kind = 'anonymous' AND banned_at IS NULL AND last_seen_at < ?", [anonymousCutoff]);
      });
    },
  };

  const health: HealthService = {
    async ping() {
      await runner(pool).query("SELECT 1 AS ok");
    },
  };

  const roomPersistence: RoomPersistence = {
    async createRoom({ id, pool: poolName, musicId, gameVersion, songJson, chartsJson, now }) {
      await exec(pool,
        "INSERT INTO rooms(id,pool,music_id,game_version,status,song_json,charts_json,player_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [id, poolName, musicId, gameVersion, "recruiting", songJson, chartsJson, 0, now, now]);
    },
    async reserveSeat({ roomId, peerId, identityId, username, cardId, serverDomain, selectedDifficulty, level, bpm, designer, playerCount, now }) {
      await tx(pool, async (conn) => {
        await exec(conn,
          "INSERT INTO room_members(room_id,peer_id,identity_id,username,card_id,server_domain,selected_difficulty,level,bpm,designer,joined_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [roomId, peerId, identityId, username, cardId, serverDomain,
            selectedDifficulty, level, bpm, designer, now]);
        await exec(conn, "UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ?", [playerCount, now, roomId]);
      });
    },
    async markConnected(roomId, peerId) {
      await exec(pool, "UPDATE room_members SET connected = 1 WHERE room_id = ? AND peer_id = ?", [roomId, peerId]);
    },
    async updateReady(roomId, peerId, selectedDifficulty, level, bpm, designer) {
      await exec(pool, "UPDATE room_members SET selected_difficulty = ?, level = ?, bpm = ?, designer = ? WHERE room_id = ? AND peer_id = ?",
        [selectedDifficulty, level, bpm, designer, roomId, peerId]);
    },
    async startPlay({ playId, roomId, pool: poolName, songJson, chartsJson, participantsJson, startedAt, playerCount, now }) {
      await tx(pool, async (conn) => {
        await exec(conn,
          "INSERT INTO plays(id,room_id,pool,song_json,charts_json,participants_json,started_at) VALUES(?,?,?,?,?,?,?)",
          [playId, roomId, poolName, songJson, chartsJson, participantsJson, startedAt]);
        await exec(conn, "DELETE FROM room_members WHERE room_id = ? AND connected = 0", [roomId]);
        await exec(conn, "UPDATE rooms SET status = 'playing', started_at = ?, player_count = ?, updated_at = ? WHERE id = ?",
          [startedAt, playerCount, now, roomId]);
      });
    },
    async playParticipantsJson(playId) {
      const row = await selectFirst<{ participants_json: string }>(pool, "SELECT participants_json FROM plays WHERE id = ?", [playId]);
      return row?.participants_json ?? null;
    },
    async finishPlay({ playId, roomId, cancelled, reason, participantsJson, now }) {
      await tx(pool, async (conn) => {
        if (cancelled) await exec(conn, "DELETE FROM plays WHERE id = ?", [playId]);
        else await exec(conn, "UPDATE plays SET ended_at = ?, end_reason = ?, participants_json = ? WHERE id = ? AND ended_at IS NULL",
          [now, reason, participantsJson, playId]);
        await exec(conn, "UPDATE rooms SET status = 'recruiting', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'playing'", [now, roomId]);
      });
    },
    async removeMemberPlaying(roomId, peerId, playerCount, now) {
      await tx(pool, async (conn) => {
        await exec(conn, "DELETE FROM room_members WHERE room_id = ? AND peer_id = ?", [roomId, peerId]);
        await exec(conn, "UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status = 'playing'", [playerCount, now, roomId]);
      });
    },
    async removeMember(roomId, peerId) {
      await exec(pool, "DELETE FROM room_members WHERE room_id = ? AND peer_id = ?", [roomId, peerId]);
    },
    async updatePlayerCount(roomId, playerCount, now) {
      await exec(pool, "UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')",
        [playerCount, now, roomId]);
    },
    async banRemoveMember({ roomId, peerId, identityId, playerCount, now }) {
      await tx(pool, async (conn) => {
        await exec(conn, "DELETE FROM room_members WHERE room_id = ? AND peer_id = ? AND identity_id = ?", [roomId, peerId, identityId]);
        await exec(conn, "UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')", [playerCount, now, roomId]);
      });
    },
    async closeRoomPersist({ roomId, reason, now, play }) {
      await tx(pool, async (conn) => {
        if (play) {
          if (play.cancelled) await exec(conn, "DELETE FROM plays WHERE id = ?", [play.id]);
          else await exec(conn, "UPDATE plays SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", [now, reason, play.id]);
        }
        await exec(conn, "UPDATE rooms SET status = 'closed', player_count = 0, updated_at = ? WHERE id = ?", [now, roomId]);
        await exec(conn, "UPDATE room_members SET connected = 0 WHERE room_id = ?", [roomId]);
      });
    },
    async recoverExpiredRoom(roomId, reason, now) {
      return tx(pool, async (conn) => {
        const room = await selectFirst<{ pool: string; status: string }>(conn,
          "SELECT pool,status FROM rooms WHERE id = ? FOR UPDATE", [roomId]);
        if (!room || (room.status !== "recruiting" && room.status !== "playing")) return null;
        await exec(conn, "UPDATE plays SET ended_at = ?, end_reason = ? WHERE room_id = ? AND ended_at IS NULL",
          [now, reason, roomId]);
        await exec(conn, "UPDATE rooms SET status = 'closed', player_count = 0, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')",
          [now, roomId]);
        await exec(conn, "UPDATE room_members SET connected = 0 WHERE room_id = ?", [roomId]);
        return room.pool;
      });
    },
  };

  return { identities, challenges, playerControls, roomQueries, directoryQueries, adminQueries, settings, cleanup, health, roomPersistence };
}
