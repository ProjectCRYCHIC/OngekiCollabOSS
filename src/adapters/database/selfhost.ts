import type {
  AdminQueries, ChallengeRepository, CleanupStore, DirectoryQueries, HealthService,
  IdentityRepository, PlayerControlRepository, RoomQueryRepository, SettingsRepository,
} from "../../core/ports.js";
import type { RoomPersistence } from "../../core/rooms/persistence.js";

/** Persistent stores required by the self-hosted runtime. Both MySQL/MariaDB
 * and SQLite implement this exact port bundle; business code never branches on
 * the selected database. */
export interface SelfhostDataStores {
  identities: IdentityRepository;
  challenges: ChallengeRepository;
  playerControls: PlayerControlRepository;
  roomQueries: RoomQueryRepository;
  directoryQueries: DirectoryQueries;
  adminQueries: AdminQueries;
  settings: SettingsRepository;
  cleanup: CleanupStore;
  health: HealthService;
  roomPersistence: RoomPersistence;
}
