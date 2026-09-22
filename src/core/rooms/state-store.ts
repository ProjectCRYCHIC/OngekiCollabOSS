import type { MetaRow, MemberRow, PlayScoreRow } from "./types.js";

/** Authoritative live room state. Durable Object SQLite on Cloudflare, Redis
 *  self-hosted; every method mirrors one statement of the original engine. */
export interface RoomStateStore {
  getMeta(): Promise<MetaRow | null>;
  insertMeta(meta: MetaRow): Promise<void>;
  deleteMeta(id: string): Promise<void>;
  updateMetaStatus(status: string): Promise<void>;
  updateMetaTransition(input: { status: string; playId: string | null; startedAt: number | null }): Promise<void>;
  /** Refreshes the self-hosted live-state lease after real socket activity; a no-op on Durable Objects. */
  touchActive(): Promise<void>;

  getMembers(): Promise<MemberRow[]>;
  getMember(peerId: number): Promise<MemberRow | null>;
  getConnectedMember(peerId: number, identityId: string): Promise<MemberRow | null>;
  rereserve(peerId: number, reservationId: string, now: number): Promise<void>;
  insertMember(member: MemberRow): Promise<void>;
  deleteMember(peerId: number): Promise<void>;
  deleteMemberByIdentity(peerId: number, identityId: string): Promise<void>;
  markConnected(peerId: number): Promise<void>;
  /** Marks a previously connected seat for retryable disconnect cleanup. */
  markDisconnected(peerId: number): Promise<void>;
  /** closeRoom: connected = 0 and ready state cleared together. */
  markDisconnectedReset(): Promise<void>;
  /** endPlay: ready state cleared, rtt reset. */
  clearReady(): Promise<void>;
  /** A player returned from FinishSetting to Joined; invalidate only its stale Ready report. */
  clearMemberReady(peerId: number): Promise<void>;
  updateReady(peerId: number, readyJson: string, selectedDifficulty: number, level: number, bpm: number, designer: string, rttMs: number): Promise<void>;

  getScores(): Promise<PlayScoreRow[]>;
  seedScore(peerId: number, name: string): Promise<void>;
  upsertScore(peerId: number, name: string, playJson: string): Promise<void>;
  markScoreDropped(peerId: number, name: string, now: number): Promise<void>;
  clearScores(): Promise<void>;
}
