import type { RoomStateStore } from "../../../core/rooms/state-store.js";
import type { MemberRow, MetaRow, PlayScoreRow } from "../../../core/rooms/types.js";

interface MemoryRoomData {
  meta: MetaRow | null;
  members: Map<number, MemberRow>;
  scores: Map<number, PlayScoreRow>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Process-local equivalent of the Redis room hashes. It deliberately exposes
 * only RoomStateStore, so RoomEngine behavior remains shared. */
export class MemoryRoomStateRepository {
  private readonly rooms = new Map<string, MemoryRoomData>();

  state(roomId: string): RoomStateStore {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { meta: null, members: new Map(), scores: new Map() };
      this.rooms.set(roomId, room);
    }
    const data = room;
    const member = (peerId: number): MemberRow | null => {
      const found = data.members.get(peerId);
      return found ? clone(found) : null;
    };
    return {
      async getMeta() { return data.meta ? clone(data.meta) : null; },
      async insertMeta(meta) { data.meta = clone(meta); },
      async deleteMeta() { data.meta = null; },
      async updateMetaStatus(status) { if (data.meta) data.meta.status = status; },
      async updateMetaTransition({ status, playId, startedAt }) {
        if (data.meta) Object.assign(data.meta, { status, play_id: playId, started_at: startedAt });
      },
      async touchActive() { /* process memory has no lease */ },

      async getMembers() { return [...data.members.values()].sort((a, b) => a.peer_id - b.peer_id).map(clone); },
      async getMember(peerId) { return member(peerId); },
      async getConnectedMember(peerId, identityId) {
        const found = member(peerId);
        return found?.identity_id === identityId && found.connected === 1 ? found : null;
      },
      async rereserve(peerId, reservationId, now) {
        const found = data.members.get(peerId);
        if (found) Object.assign(found, { reservation_id: reservationId, reserved_at: now });
      },
      async insertMember(value) { data.members.set(value.peer_id, clone(value)); },
      async deleteMember(peerId) { data.members.delete(peerId); },
      async deleteMemberByIdentity(peerId, identityId) {
        if (data.members.get(peerId)?.identity_id === identityId) data.members.delete(peerId);
      },
      async markConnected(peerId) { const found = data.members.get(peerId); if (found) found.connected = 1; },
      async markDisconnected(peerId) {
        const found = data.members.get(peerId);
        if (found) Object.assign(found, { connected: 0, reserved_at: 0 });
      },
      async markDisconnectedReset() {
        for (const found of data.members.values()) Object.assign(found, { connected: 0, ready_json: null });
      },
      async clearReady() {
        for (const found of data.members.values()) Object.assign(found, { ready_json: null, rtt_ms: 0 });
      },
      async clearMemberReady(peerId) {
        const found = data.members.get(peerId);
        if (found) Object.assign(found, { ready_json: null, rtt_ms: 0 });
      },
      async updateReady(peerId, readyJson, selectedDifficulty, level, bpm, designer, rttMs) {
        const found = data.members.get(peerId);
        if (found) Object.assign(found, { ready_json: readyJson, selected_difficulty: selectedDifficulty, level, bpm, designer, rtt_ms: rttMs });
      },

      async getScores() { return [...data.scores.values()].map(clone); },
      async seedScore(peerId, name) {
        if (!data.scores.has(peerId)) data.scores.set(peerId, { peer_id: peerId, name, play_json: null, disconnected_at: null });
      },
      async upsertScore(peerId, name, playJson) {
        data.scores.set(peerId, { peer_id: peerId, name, play_json: playJson, disconnected_at: null });
      },
      async markScoreDropped(peerId, name, now) {
        const previous = data.scores.get(peerId);
        data.scores.set(peerId, { peer_id: peerId, name, play_json: previous?.play_json ?? null, disconnected_at: now });
      },
      async clearScores() { data.scores.clear(); },
    };
  }

  delete(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
