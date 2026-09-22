import type { RoomStateStore } from "../../../core/rooms/state-store.js";
import type { MetaRow, MemberRow, PlayScoreRow } from "../../../core/rooms/types.js";

/** Durable Object SQLite implementation of the authoritative live room state.
 *  Statements carry over verbatim from the original RelayRoom storage. */
export function createSqliteRoomState(ctx: DurableObjectState): RoomStateStore {
  const sql = ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS room_meta (id TEXT PRIMARY KEY, coordinator TEXT NOT NULL, pool TEXT NOT NULL, game_version TEXT NOT NULL, song_json TEXT NOT NULL, charts_json TEXT NOT NULL, status TEXT NOT NULL, host_peer_id INTEGER NOT NULL, play_id TEXT, started_at INTEGER, created_at INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS members (peer_id INTEGER PRIMARY KEY, identity_id TEXT NOT NULL, reservation_id TEXT NOT NULL, username TEXT NOT NULL, card_id INTEGER NOT NULL DEFAULT 0, server_domain TEXT NOT NULL, selected_difficulty INTEGER NOT NULL, level REAL NOT NULL, bpm INTEGER NOT NULL, designer TEXT NOT NULL, connected INTEGER NOT NULL DEFAULT 0, ready_json TEXT, rtt_ms INTEGER NOT NULL DEFAULT 0, reserved_at INTEGER NOT NULL)");
  const memberColumns = new Set((sql.exec("PRAGMA table_info(members)").toArray() as Array<{ name: string }>).map((column) => column.name));
  if (!memberColumns.has("card_id")) sql.exec("ALTER TABLE members ADD COLUMN card_id INTEGER NOT NULL DEFAULT 0");
  sql.exec("CREATE TABLE IF NOT EXISTS play_scores (peer_id INTEGER PRIMARY KEY, name TEXT NOT NULL, play_json TEXT, disconnected_at INTEGER)");

  const all = <T>(statement: string, ...bindings: unknown[]): T[] =>
    sql.exec(statement, ...bindings).toArray() as unknown as T[];

  return {
    async getMeta() {
      return (all<MetaRow>("SELECT * FROM room_meta LIMIT 1"))[0] ?? null;
    },
    async insertMeta(meta) {
      sql.exec("INSERT INTO room_meta(id,coordinator,pool,game_version,song_json,charts_json,status,host_peer_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        meta.id, meta.coordinator, meta.pool, meta.game_version, meta.song_json, meta.charts_json, meta.status, meta.host_peer_id, meta.created_at);
    },
    async deleteMeta(id) {
      sql.exec("DELETE FROM room_meta WHERE id = ?", id);
    },
    async updateMetaStatus(status) {
      sql.exec("UPDATE room_meta SET status = ?", status);
    },
    async updateMetaTransition({ status, playId, startedAt }) {
      sql.exec("UPDATE room_meta SET status = ?, play_id = ?, started_at = ?", status, playId, startedAt);
    },
    async touchActive() { /* Durable Object SQLite has no live-state TTL. */ },

    async getMembers() {
      return all<MemberRow>("SELECT * FROM members ORDER BY peer_id");
    },
    async getMember(peerId) {
      return (all<MemberRow>("SELECT * FROM members WHERE peer_id = ?", peerId))[0] ?? null;
    },
    async getConnectedMember(peerId, identityId) {
      return (all<MemberRow>("SELECT * FROM members WHERE peer_id = ? AND identity_id = ? AND connected = 1", peerId, identityId))[0] ?? null;
    },
    async rereserve(peerId, reservationId, now) {
      sql.exec("UPDATE members SET reservation_id = ?, reserved_at = ? WHERE peer_id = ?", reservationId, now, peerId);
    },
    async insertMember(member) {
      sql.exec("INSERT INTO members(peer_id,identity_id,reservation_id,username,card_id,server_domain,selected_difficulty,level,bpm,designer,reserved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        member.peer_id, member.identity_id, member.reservation_id, member.username, member.card_id, member.server_domain,
        member.selected_difficulty, member.level, member.bpm, member.designer, member.reserved_at);
    },
    async deleteMember(peerId) {
      sql.exec("DELETE FROM members WHERE peer_id = ?", peerId);
    },
    async deleteMemberByIdentity(peerId, identityId) {
      sql.exec("DELETE FROM members WHERE peer_id = ? AND identity_id = ?", peerId, identityId);
    },
    async markConnected(peerId) {
      sql.exec("UPDATE members SET connected = 1 WHERE peer_id = ?", peerId);
    },
    async markDisconnected(peerId) {
      sql.exec("UPDATE members SET connected = 0, reserved_at = 0 WHERE peer_id = ?", peerId);
    },
    async markDisconnectedReset() {
      sql.exec("UPDATE members SET connected = 0, ready_json = NULL");
    },
    async clearReady() {
      sql.exec("UPDATE members SET ready_json = NULL, rtt_ms = 0");
    },
    async clearMemberReady(peerId) {
      sql.exec("UPDATE members SET ready_json = NULL, rtt_ms = 0 WHERE peer_id = ?", peerId);
    },
    async updateReady(peerId, readyJson, selectedDifficulty, level, bpm, designer, rttMs) {
      sql.exec("UPDATE members SET ready_json = ?, selected_difficulty = ?, level = ?, bpm = ?, designer = ?, rtt_ms = ? WHERE peer_id = ?",
        readyJson, selectedDifficulty, level, bpm, designer, rttMs, peerId);
    },

    async getScores() {
      return all<PlayScoreRow>("SELECT peer_id,name,play_json,disconnected_at FROM play_scores");
    },
    async seedScore(peerId, name) {
      sql.exec(
        "INSERT INTO play_scores(peer_id,name,play_json,disconnected_at) VALUES(?,?,NULL,NULL) " +
        "ON CONFLICT(peer_id) DO NOTHING", peerId, name);
    },
    async upsertScore(peerId, name, playJson) {
      sql.exec(
        "INSERT INTO play_scores(peer_id,name,play_json,disconnected_at) VALUES(?,?,?,NULL) " +
        "ON CONFLICT(peer_id) DO UPDATE SET play_json = excluded.play_json, disconnected_at = NULL",
        peerId, name, playJson);
    },
    async markScoreDropped(peerId, name, now) {
      sql.exec(
        "INSERT INTO play_scores(peer_id,name,play_json,disconnected_at) VALUES(?,?,COALESCE((SELECT play_json FROM play_scores WHERE peer_id = ?),NULL),?) " +
        "ON CONFLICT(peer_id) DO UPDATE SET disconnected_at = excluded.disconnected_at",
        peerId, name, peerId, now);
    },
    async clearScores() {
      sql.exec("DELETE FROM play_scores");
    },
  };
}
