import type { MatchRequest, SongManifest } from "./protocol.js";
import type { IdentityHashes } from "./crypto.js";

export type { IdentityHashes };

// ---------------------------------------------------------------------------
// Row shapes. Column names deliberately match both the D1 and the MySQL/MariaDB
// schemas so a future D1 -> MySQL transfer can copy rows verbatim.
// ---------------------------------------------------------------------------

export interface IdentityRow { id: string; keychip_hash: string; access_hash: string; user_hash: string; server_hash: string; composite_hash: string; server_domain: string; encrypted_key: string }
export type IdentityBinding = Pick<IdentityRow, "id" | "composite_hash" | "encrypted_key">;
export interface ChallengeRow { id: string; identity_id: string; nonce: string; expires_at: number; used_at: number | null }
export interface PlayerControlRow { id: string; kind: "registered" | "anonymous"; username: string; server_domain: string; created_at: number; last_seen_at: number; banned_at: number | null; ban_reason: string | null }
export interface RoomCoreRow { id: string; pool: string; status: string; game_version: string; song_json: string }
export interface RoomDirectoryRow { id: string; pool: string; status: string; song_json: string; player_count: number; max_players: number; created_at: number; started_at: number | null; updated_at: number }
export interface RoomAdminRow { id: string; pool: string; status: string; song_json: string; player_count: number; created_at: number; started_at: number | null; updated_at: number }
export interface RoomMemberPublicRow { peer_id: number; username: string; card_id: number; selected_difficulty: number; level: number; connected: number }
export interface RoomMemberAdminRow { identity_id: string; username: string; server_domain: string }
export interface PlayHistoryRow { id: string; room_id: string; pool: string; song_json: string; participants_json: string; started_at: number; ended_at: number; end_reason: string }

export class UniqueConstraintError extends Error {
  constructor() {
    super("Duplicate key");
    this.name = "UniqueConstraintError";
  }
}

export interface PageInput { pool: string; limit: number; beforeTime: number | null; beforeId: string | null }
export interface CursorPage { limit: number; beforeTime: number | null; beforeId: string | null }
export interface PagedRows<Row> { rows: Row[]; hasMore: boolean }

// ---------------------------------------------------------------------------
// Persistent-data repositories (D1 on Cloudflare; MySQL/MariaDB or SQLite self-hosted).
// ---------------------------------------------------------------------------

export interface IdentityRepository {
  findBinding(hashes: IdentityHashes): Promise<IdentityBinding | null>;
  create(input: { id: string; hashes: IdentityHashes; encryptedKey: string; now: number }): Promise<void>;
  exists(id: string): Promise<boolean>;
  findById(id: string): Promise<IdentityRow | null>;
  findSessionIdentity(id: string): Promise<{ id: string; server_domain: string } | null>;
  /** Conditional legacy full-URI -> hostname rebinding; true when this call performed it. */
  migrateServerHash(identityId: string, hashes: IdentityHashes, previous: IdentityRow, now: number): Promise<boolean>;
  deleteWithChallenges(id: string): Promise<void>;
}

export interface ChallengeRepository {
  create(input: { id: string; identityId: string; nonce: string; expiresAt: number }): Promise<void>;
  find(challengeId: string, identityId: string): Promise<ChallengeRow | null>;
  /** Single-use consumption; true when this call consumed the challenge. */
  consume(challengeId: string, now: number): Promise<boolean>;
}

export interface PlayerControlRepository {
  /** Upsert the last-seen projection; true when the player is not banned. */
  record(id: string, kind: PlayerControlRow["kind"], username: string, serverDomain: string, now: number): Promise<boolean>;
  ban(id: string, reason: "abuse" | "disruption" | "other" | null, now: number): Promise<boolean>;
  unban(id: string): Promise<boolean>;
  bannedAt(id: string): Promise<{ banned_at: number | null } | null>;
  activeRoomIdsFor(identityId: string): Promise<string[]>;
}

export interface RoomQueryRepository {
  findById(id: string): Promise<RoomCoreRow | null>;
  findOwnRecruitingHost(identityId: string, pool: string): Promise<RoomCoreRow | null>;
}

export interface DirectoryQueries {
  activeRoomRows(page: PageInput): Promise<PagedRows<RoomDirectoryRow>>;
  memberRows(roomId: string): Promise<RoomMemberPublicRow[]>;
  historyRows(page: PageInput, endedAfter: number): Promise<PagedRows<PlayHistoryRow>>;
}

export interface AdminQueries {
  playerRows(params: { query: string; limit: number; beforeTime: number | null; beforeId: string | null }): Promise<PagedRows<PlayerControlRow>>;
  battleRows(page: CursorPage): Promise<PagedRows<RoomAdminRow>>;
  battleMemberRows(roomId: string): Promise<RoomMemberAdminRow[]>;
}

export interface SettingRow { value: string; updatedAt: number | null }

export interface SettingsRepository {
  getIdentityRequired(): Promise<{ required: boolean; updatedAt: number | null }>;
  setIdentityRequired(required: boolean, now: number): Promise<void>;
  /** Generic service-settings access (admin credentials live here too). */
  getValue(key: string): Promise<SettingRow | null>;
  setValue(key: string, value: string, now: number): Promise<void>;
}

export interface CleanupStore {
  purge(input: { expiredBefore: number; playCutoff: number; anonymousCutoff: number }): Promise<void>;
}

export interface HealthService {
  ping(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Realtime coordination (Durable Objects on Cloudflare; Redis or memory self-hosted).
// ---------------------------------------------------------------------------

export interface Seat { peerId: number; reservationId: string }
export interface Reservation { identityId: string; username: string; cardId?: number; serverDomain: string; song: SongManifest }

export interface RoomRealtimeService {
  reserve(roomId: string, reservation: Reservation): Promise<Seat | null>;
  banPlayer(roomId: string, identityId: string): Promise<boolean>;
  forceClose(roomId: string): Promise<boolean>;
}

export interface PoolRealtimeService {
  create(request: MatchRequest, reservation: Reservation): Promise<{ roomId: string; peerId: number; reservationId: string; status: string }>;
}

export interface RateLimitService {
  /** Fixed-window counter keyed by (client key, endpoint kind). */
  allow(key: string, kind: string, limit: number, windowMs: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Cross-cutting services.
// ---------------------------------------------------------------------------

export interface SongCatalogCache {
  get(): Promise<SongCatalog | null>;
  set(catalog: SongCatalog): Promise<void>;
}

export interface CatalogSong {
  t: string;
  a: string;
  c: string;
  v: string;
  b: number;
  d: string;
  i: string;
  l: Array<string | null>;
}

export interface SongCatalog { updated: string; songs: CatalogSong[] }

export interface AdminAuthenticator {
  authenticate(request: Request): Promise<boolean>;
}

/** Self-hosted password sessions (login/logout). Absent on Cloudflare, where
 *  Zero Trust / Access authenticates /admin before the request arrives. */
export interface AdminSessionService {
  /** Validates credentials and opens a session; returns the login response. */
  login(request: Request): Promise<Response>;
  /** Destroys the caller's session and clears the cookie. */
  logout(request: Request): Promise<Response>;
  /** Revokes every active session (used after a password reset). */
  revokeAll(): Promise<void>;
  /** The status code for unauthenticated admin API calls (401 self-hosted). */
  readonly unauthorizedStatus: number;
}

export interface AppSecrets { identityHash: string; keyEncryption: string; ticketSigning: string; adminReset: string }

/** Everything a request handler may touch. Runtimes assemble this once from
 *  their platform bindings; handlers never see platform types. */
export interface AppServices {
  secrets: AppSecrets;
  /** SHA-256 client key for rate limiting. */
  clientKey(request: Request): Promise<string>;
  /** Present only in self-hosted deployments. */
  adminSession?: AdminSessionService;
  identities: IdentityRepository;
  challenges: ChallengeRepository;
  playerControls: PlayerControlRepository;
  roomQueries: RoomQueryRepository;
  directoryQueries: DirectoryQueries;
  adminQueries: AdminQueries;
  settings: SettingsRepository;
  cleanup: CleanupStore;
  health: HealthService;
  rooms: RoomRealtimeService;
  pools: PoolRealtimeService;
  rateLimit: RateLimitService;
  catalogCache: SongCatalogCache;
  adminAuth: AdminAuthenticator;
  serveAdminStatic(request: Request, assetPath: string): Promise<Response>;
}
