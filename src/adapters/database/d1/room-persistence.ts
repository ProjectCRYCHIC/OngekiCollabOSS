import type { RoomPersistence } from "../../../core/rooms/persistence.js";
import type { PortableSqliteDatabase } from "../sqlite/protocol.js";

/** D1 mirror of the live room state. Every batch matches the original inline
 *  statements of the RelayRoom engine statement for statement. */
export function createD1RoomPersistence(db: PortableSqliteDatabase): RoomPersistence {
  return {
    async createRoom({ id, pool, musicId, gameVersion, songJson, chartsJson, now }) {
      await db.prepare("INSERT INTO rooms(id,pool,music_id,game_version,status,song_json,charts_json,player_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(id, pool, musicId, gameVersion, "recruiting", songJson, chartsJson, 0, now, now).run();
    },
    async reserveSeat({ roomId, peerId, identityId, username, cardId, serverDomain, selectedDifficulty, level, bpm, designer, playerCount, now }) {
      await db.batch([
        db.prepare("INSERT INTO room_members(room_id,peer_id,identity_id,username,card_id,server_domain,selected_difficulty,level,bpm,designer,joined_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .bind(roomId, peerId, identityId, username, cardId, serverDomain,
            selectedDifficulty, level, bpm, designer, now),
        db.prepare("UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ?").bind(playerCount, now, roomId),
      ]);
    },
    async markConnected(roomId, peerId) {
      await db.prepare("UPDATE room_members SET connected = 1 WHERE room_id = ? AND peer_id = ?").bind(roomId, peerId).run();
    },
    async updateReady(roomId, peerId, selectedDifficulty, level, bpm, designer) {
      await db.prepare("UPDATE room_members SET selected_difficulty = ?, level = ?, bpm = ?, designer = ? WHERE room_id = ? AND peer_id = ?")
        .bind(selectedDifficulty, level, bpm, designer, roomId, peerId).run();
    },
    async startPlay({ playId, roomId, pool, songJson, chartsJson, participantsJson, startedAt, playerCount, now }) {
      await db.batch([
        db.prepare("INSERT INTO plays(id,room_id,pool,song_json,charts_json,participants_json,started_at) VALUES(?,?,?,?,?,?,?)")
          .bind(playId, roomId, pool, songJson, chartsJson, participantsJson, startedAt),
        db.prepare("DELETE FROM room_members WHERE room_id = ? AND connected = 0").bind(roomId),
        db.prepare("UPDATE rooms SET status = 'playing', started_at = ?, player_count = ?, updated_at = ? WHERE id = ?")
          .bind(startedAt, playerCount, now, roomId),
      ]);
    },
    async playParticipantsJson(playId) {
      const row = await db.prepare("SELECT participants_json FROM plays WHERE id = ?").bind(playId).first<{ participants_json: string }>();
      return row?.participants_json ?? null;
    },
    async finishPlay({ playId, roomId, cancelled, reason, participantsJson, now }) {
      await db.batch([
        cancelled
          ? db.prepare("DELETE FROM plays WHERE id = ?").bind(playId)
          : db.prepare("UPDATE plays SET ended_at = ?, end_reason = ?, participants_json = ? WHERE id = ? AND ended_at IS NULL").bind(now, reason, participantsJson, playId),
        db.prepare("UPDATE rooms SET status = 'recruiting', started_at = NULL, updated_at = ? WHERE id = ? AND status = 'playing'").bind(now, roomId),
      ]);
    },
    async removeMemberPlaying(roomId, peerId, playerCount, now) {
      await db.batch([
        db.prepare("DELETE FROM room_members WHERE room_id = ? AND peer_id = ?").bind(roomId, peerId),
        db.prepare("UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status = 'playing'")
          .bind(playerCount, now, roomId),
      ]);
    },
    async removeMember(roomId, peerId) {
      await db.prepare("DELETE FROM room_members WHERE room_id = ? AND peer_id = ?").bind(roomId, peerId).run();
    },
    async updatePlayerCount(roomId, playerCount, now) {
      await db.prepare("UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')")
        .bind(playerCount, now, roomId).run();
    },
    async banRemoveMember({ roomId, peerId, identityId, playerCount, now }) {
      await db.batch([
        db.prepare("DELETE FROM room_members WHERE room_id = ? AND peer_id = ? AND identity_id = ?")
          .bind(roomId, peerId, identityId),
        db.prepare("UPDATE rooms SET player_count = ?, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')")
          .bind(playerCount, now, roomId),
      ]);
    },
    async closeRoomPersist({ roomId, reason, now, play }) {
      const updates = [
        db.prepare("UPDATE rooms SET status = 'closed', player_count = 0, updated_at = ? WHERE id = ?")
          .bind(now, roomId),
        db.prepare("UPDATE room_members SET connected = 0 WHERE room_id = ?").bind(roomId),
      ];
      if (play) updates.unshift(play.cancelled
        ? db.prepare("DELETE FROM plays WHERE id = ?").bind(play.id)
        : db.prepare("UPDATE plays SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
          .bind(now, reason, play.id));
      await db.batch(updates);
    },
    async recoverExpiredRoom(roomId, reason, now) {
      const room = await db.prepare("SELECT pool,status FROM rooms WHERE id = ?").bind(roomId)
        .first<{ pool: string; status: string }>();
      if (!room || (room.status !== "recruiting" && room.status !== "playing")) return null;
      await db.batch([
        db.prepare("UPDATE plays SET ended_at = ?, end_reason = ? WHERE room_id = ? AND ended_at IS NULL")
          .bind(now, reason, roomId),
        db.prepare("UPDATE rooms SET status = 'closed', player_count = 0, updated_at = ? WHERE id = ? AND status IN ('recruiting','playing')")
          .bind(now, roomId),
        db.prepare("UPDATE room_members SET connected = 0 WHERE room_id = ?").bind(roomId),
      ]);
      return room.pool;
    },
  };
}
