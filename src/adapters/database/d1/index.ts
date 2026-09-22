import { UniqueConstraintError } from "../../../core/ports.js";
import type {
  AdminQueries, ChallengeRepository, CleanupStore, CursorPage, DirectoryQueries, HealthService,
  IdentityHashes, IdentityRepository, IdentityRow, PagedRows, PageInput, PlayerControlRepository,
  PlayerControlRow, RoomAdminRow, RoomCoreRow, RoomDirectoryRow, RoomMemberAdminRow,
  RoomMemberPublicRow, SettingsRepository,
} from "../../../core/ports.js";
import type { PortableSqliteDatabase } from "../sqlite/protocol.js";
import type {
  ChallengeRow, IdentityBinding, PlayHistoryRow, RoomQueryRepository,
} from "../../../core/ports.js";

// D1 implementations of the persistent-data ports. Every statement is carried
// over verbatim from the original inline SQL; only the transport changed.

export interface D1DataStores {
  identities: IdentityRepository;
  challenges: ChallengeRepository;
  playerControls: PlayerControlRepository;
  roomQueries: RoomQueryRepository;
  directoryQueries: DirectoryQueries;
  adminQueries: AdminQueries;
  settings: SettingsRepository;
  cleanup: CleanupStore;
  health: HealthService;
}

export function createD1DataStores(db: PortableSqliteDatabase): D1DataStores {
  const identities: IdentityRepository = {
    async findBinding(hashes: IdentityHashes) {
      return db.prepare("SELECT id, composite_hash, encrypted_key FROM identities WHERE composite_hash = ? OR keychip_hash = ? OR access_hash = ? OR user_hash = ?")
        .bind(hashes.compositeHash, hashes.keychipHash, hashes.accessHash, hashes.userHash)
        .first<IdentityBinding>();
    },
    async create({ id, hashes, encryptedKey, now }) {
      try {
        await db.prepare("INSERT INTO identities(id,keychip_hash,access_hash,user_hash,server_hash,composite_hash,server_domain,encrypted_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .bind(id, hashes.keychipHash, hashes.accessHash, hashes.userHash, hashes.serverHash,
            hashes.compositeHash, hashes.serverDomain, encryptedKey, now, now).run();
      } catch (cause) {
        if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) throw new UniqueConstraintError();
        throw cause;
      }
    },
    async exists(id) {
      return Boolean(await db.prepare("SELECT id FROM identities WHERE id = ?").bind(id).first<{ id: string }>());
    },
    async findById(id) {
      return db.prepare("SELECT * FROM identities WHERE id = ?").bind(id).first<IdentityRow>();
    },
    async findSessionIdentity(id) {
      return db.prepare("SELECT id,server_domain FROM identities WHERE id = ?").bind(id).first<{ id: string; server_domain: string }>();
    },
    async migrateServerHash(identityId, hashes, previous: IdentityRow, now) {
      const migrated = await db.prepare("UPDATE identities SET server_hash = ?, composite_hash = ?, updated_at = ? WHERE id = ? AND keychip_hash = ? AND access_hash = ? AND user_hash = ? AND server_hash = ? AND composite_hash = ?")
        .bind(hashes.serverHash, hashes.compositeHash, now, identityId, previous.keychip_hash,
          previous.access_hash, previous.user_hash, previous.server_hash, previous.composite_hash).run();
      return migrated.meta.changes === 1;
    },
    async deleteWithChallenges(id) {
      await db.batch([
        db.prepare("DELETE FROM challenges WHERE identity_id = ?").bind(id),
        db.prepare("DELETE FROM identities WHERE id = ?").bind(id),
      ]);
    },
  };

  const challenges: ChallengeRepository = {
    async create({ id, identityId, nonce, expiresAt }) {
      await db.prepare("INSERT INTO challenges(id,identity_id,nonce,expires_at) VALUES(?,?,?,?)")
        .bind(id, identityId, nonce, expiresAt).run();
    },
    async find(challengeId, identityId) {
      return db.prepare("SELECT * FROM challenges WHERE id = ? AND identity_id = ?").bind(challengeId, identityId).first<ChallengeRow>();
    },
    async consume(challengeId, now) {
      const used = await db.prepare("UPDATE challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
        .bind(now, challengeId, now).run();
      return used.meta.changes === 1;
    },
  };

  const playerControls: PlayerControlRepository = {
    async record(id, kind, username, serverDomain, now) {
      await db.prepare("INSERT INTO player_controls(id,kind,username,server_domain,created_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE player_controls.username END, server_domain = excluded.server_domain, last_seen_at = excluded.last_seen_at")
        .bind(id, kind, username, serverDomain, now, now).run();
      const row = await db.prepare("SELECT banned_at FROM player_controls WHERE id = ?").bind(id).first<{ banned_at: number | null }>();
      return row?.banned_at == null;
    },
    async ban(id, reason, now) {
      const updated = await db.prepare("UPDATE player_controls SET banned_at = ?, ban_reason = ? WHERE id = ?")
        .bind(now, reason, id).run();
      return updated.meta.changes === 1;
    },
    async unban(id) {
      const updated = await db.prepare("UPDATE player_controls SET banned_at = NULL, ban_reason = NULL WHERE id = ?")
        .bind(id).run();
      return updated.meta.changes === 1;
    },
    async bannedAt(id) {
      return db.prepare("SELECT banned_at FROM player_controls WHERE id = ?").bind(id).first<{ banned_at: number | null }>();
    },
    async activeRoomIdsFor(identityId) {
      const rooms = await db.prepare("SELECT DISTINCT room_id FROM room_members WHERE identity_id = ? AND room_id IN (SELECT id FROM rooms WHERE status IN ('recruiting','playing'))")
        .bind(identityId).all<{ room_id: string }>();
      return rooms.results.map((room) => room.room_id);
    },
  };

  const roomQueries: RoomQueryRepository = {
    async findById(id): Promise<RoomCoreRow | null> {
      return db.prepare("SELECT id,pool,status,game_version,song_json FROM rooms WHERE id = ?").bind(id).first<RoomCoreRow>();
    },
    async findOwnRecruitingHost(identityId, pool) {
      return db.prepare(
        "SELECT r.id,r.pool,r.status,r.game_version,r.song_json FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.identity_id = ? AND m.peer_id = 1 AND r.pool = ? AND r.status = 'recruiting' ORDER BY r.updated_at DESC LIMIT 1")
        .bind(identityId, pool).first<RoomCoreRow>();
    },
  };

  const directoryQueries: DirectoryQueries = {
    async activeRoomRows(page: PageInput): Promise<PagedRows<RoomDirectoryRow>> {
      const rows = await db.prepare("SELECT id,pool,status,song_json,player_count,max_players,created_at,started_at,updated_at FROM rooms WHERE pool = ? AND status IN ('recruiting','playing') AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT ?")
        .bind(page.pool, page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId, page.limit + 1).all<RoomDirectoryRow>();
      return { rows: rows.results, hasMore: rows.results.length > page.limit };
    },
    async memberRows(roomId): Promise<RoomMemberPublicRow[]> {
      const rows = await db.prepare("SELECT peer_id,username,card_id,selected_difficulty,level,connected FROM room_members WHERE room_id = ? ORDER BY peer_id")
        .bind(roomId).all<RoomMemberPublicRow>();
      return rows.results;
    },
    async historyRows(page: PageInput, endedAfter: number): Promise<PagedRows<PlayHistoryRow>> {
      const rows = await db.prepare("SELECT id,room_id,pool,song_json,participants_json,started_at,ended_at,end_reason FROM plays WHERE pool = ? AND ended_at IS NOT NULL AND ended_at >= ? AND (? IS NULL OR ended_at < ? OR (ended_at = ? AND id < ?)) ORDER BY ended_at DESC,id DESC LIMIT ?")
        .bind(page.pool, endedAfter, page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId, page.limit + 1).all<PlayHistoryRow>();
      return { rows: rows.results, hasMore: rows.results.length > page.limit };
    },
  };

  const adminQueries: AdminQueries = {
    async playerRows(params): Promise<PagedRows<PlayerControlRow>> {
      const escaped = params.query.replace(/[\\%_]/g, "\\$&");
      const rows = await db.prepare("SELECT * FROM player_controls WHERE (? = '' OR id = ? OR username LIKE ? ESCAPE '\\') AND (? IS NULL OR last_seen_at < ? OR (last_seen_at = ? AND id < ?)) ORDER BY last_seen_at DESC,id DESC LIMIT ?")
        .bind(params.query, params.query, `%${escaped}%`, params.beforeTime, params.beforeTime, params.beforeTime, params.beforeId, params.limit + 1).all<PlayerControlRow>();
      return { rows: rows.results, hasMore: rows.results.length > params.limit };
    },
    async battleRows(page: CursorPage): Promise<PagedRows<RoomAdminRow>> {
      const rows = await db.prepare("SELECT id,pool,status,song_json,player_count,created_at,started_at,updated_at FROM rooms WHERE status IN ('recruiting','playing') AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC,id DESC LIMIT ?")
        .bind(page.beforeTime, page.beforeTime, page.beforeTime, page.beforeId, page.limit + 1).all<RoomAdminRow>();
      return { rows: rows.results, hasMore: rows.results.length > page.limit };
    },
    async battleMemberRows(roomId): Promise<RoomMemberAdminRow[]> {
      const rows = await db.prepare("SELECT identity_id,username,server_domain FROM room_members WHERE room_id = ? ORDER BY peer_id")
        .bind(roomId).all<RoomMemberAdminRow>();
      return rows.results;
    },
  };

  const settings: SettingsRepository = {
    async getIdentityRequired() {
      const row = await db.prepare("SELECT value, updated_at FROM service_settings WHERE key = 'identity_required'")
        .first<{ value: string; updated_at: number }>();
      return { required: row?.value === "1", updatedAt: row?.updated_at ?? null };
    },
    async setIdentityRequired(required, now) {
      await db.prepare("INSERT INTO service_settings(key,value,updated_at) VALUES('identity_required',?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(required ? "1" : "0", now).run();
    },
    async getValue(key) {
      const row = await db.prepare("SELECT value, updated_at FROM service_settings WHERE key = ?")
        .bind(key).first<{ value: string; updated_at: number }>();
      return row ? { value: row.value, updatedAt: row.updated_at } : null;
    },
    async setValue(key, value, now) {
      await db.prepare("INSERT INTO service_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(key, value, now).run();
    },
  };

  const cleanup: CleanupStore = {
    async purge({ expiredBefore, playCutoff, anonymousCutoff }) {
      await db.batch([
        db.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(expiredBefore),
        db.prepare("DELETE FROM plays WHERE ended_at IS NOT NULL AND ended_at < ?").bind(playCutoff),
        db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE status = 'closed' AND updated_at < ?)").bind(playCutoff),
        db.prepare("DELETE FROM rooms WHERE status = 'closed' AND updated_at < ?").bind(playCutoff),
        db.prepare("DELETE FROM player_controls WHERE kind = 'anonymous' AND banned_at IS NULL AND last_seen_at < ?")
          .bind(anonymousCutoff),
      ]);
    },
  };

  const health: HealthService = {
    async ping() {
      await db.prepare("SELECT 1 AS ok").first();
    },
  };

  return { identities, challenges, playerControls, roomQueries, directoryQueries, adminQueries, settings, cleanup, health };
}
