/** Durable mirror of room state (rooms/room_members/plays tables) backing the
 *  public directory, history and admin queries. D1 on Cloudflare, MySQL/MariaDB
 *  self-hosted; each method corresponds to one atomic batch of the original
 *  engine so failure/rollback semantics stay identical. */
export interface RoomPersistence {
  createRoom(input: { id: string; pool: string; musicId: number; gameVersion: string; songJson: string; chartsJson: string; now: number }): Promise<void>;
  reserveSeat(input: { roomId: string; peerId: number; identityId: string; username: string; cardId: number; serverDomain: string; selectedDifficulty: number; level: number; bpm: number; designer: string; playerCount: number; now: number }): Promise<void>;
  markConnected(roomId: string, peerId: number): Promise<void>;
  updateReady(roomId: string, peerId: number, selectedDifficulty: number, level: number, bpm: number, designer: string): Promise<void>;
  startPlay(input: { playId: string; roomId: string; pool: string; songJson: string; chartsJson: string; participantsJson: string; startedAt: number; playerCount: number; now: number }): Promise<void>;
  playParticipantsJson(playId: string): Promise<string | null>;
  finishPlay(input: { playId: string; roomId: string; cancelled: boolean; reason: string; participantsJson: string; now: number }): Promise<void>;
  removeMemberPlaying(roomId: string, peerId: number, playerCount: number, now: number): Promise<void>;
  removeMember(roomId: string, peerId: number): Promise<void>;
  updatePlayerCount(roomId: string, playerCount: number, now: number): Promise<void>;
  banRemoveMember(input: { roomId: string; peerId: number; identityId: string; playerCount: number; now: number }): Promise<void>;
  closeRoomPersist(input: { roomId: string; reason: string; now: number; play: { id: string; cancelled: boolean } | null }): Promise<void>;
  /** Self-host recovery after live state was lost or a process restarted. Returns the affected pool. */
  recoverExpiredRoom(roomId: string, reason: string, now: number): Promise<string | null>;
}
