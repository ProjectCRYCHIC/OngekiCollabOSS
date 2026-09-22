import type { MatchRequest } from "../protocol.js";

export interface RoomSetup { id: string; coordinator: string; request: MatchRequest }

/** Authoritative live room row (DO SQLite on Cloudflare, Redis self-hosted). */
export interface MetaRow { id: string; coordinator: string; pool: string; game_version: string; song_json: string; charts_json: string; status: string; host_peer_id: number; play_id: string | null; started_at: number | null; created_at: number }

/** Seat reservation/connection row. */
export interface MemberRow { peer_id: number; identity_id: string; reservation_id: string; username: string; card_id: number; server_domain: string; selected_difficulty: number; level: number; bpm: number; designer: string; connected: number; ready_json: string | null; rtt_ms: number; reserved_at: number }

/** Transient per-player live score for the spectator view; merged into the play history at endPlay. */
export interface PlayScoreRow { peer_id: number; name: string; play_json: string | null; disconnected_at: number | null }

/** Per-socket attachment state (hibernation metadata on Cloudflare). */
export interface SocketData { peerId: number; identityId: string; messages: number; windowStart: number; spectator?: boolean }
