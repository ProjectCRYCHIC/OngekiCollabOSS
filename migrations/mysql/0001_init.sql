-- MySQL 8+ / MariaDB 10.6+ schema, logically equivalent to the D1 migrations
-- 0001_init + 0002_identity_mode + 0003_player_controls. Column names match the
-- D1 schema verbatim so a future D1 -> MySQL transfer can copy rows as-is.
-- Timestamps are epoch milliseconds (BIGINT). Identity-bound string columns use
-- a binary collation to mirror SQLite's case-sensitive equality; free-text
-- search columns keep a case-insensitive collation to mirror SQLite LIKE.

CREATE TABLE IF NOT EXISTS identities (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  keychip_hash VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  access_hash VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  user_hash VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  server_hash VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  composite_hash VARCHAR(191) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  server_domain VARCHAR(255) NOT NULL,
  encrypted_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
CREATE UNIQUE INDEX identities_keychip_binding ON identities(keychip_hash);
CREATE UNIQUE INDEX identities_access_binding ON identities(access_hash);
CREATE UNIQUE INDEX identities_user_binding ON identities(user_hash);

CREATE TABLE IF NOT EXISTS challenges (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  identity_id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  nonce TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT NULL,
  FOREIGN KEY(identity_id) REFERENCES identities(id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  pool VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  music_id INT NOT NULL,
  game_version VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL,
  song_json MEDIUMTEXT NOT NULL,
  charts_json MEDIUMTEXT NOT NULL,
  player_count INT NOT NULL,
  max_players INT NOT NULL DEFAULT 4,
  created_at BIGINT NOT NULL,
  started_at BIGINT NULL,
  updated_at BIGINT NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
CREATE INDEX rooms_by_pool_status ON rooms(pool, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS room_members (
  room_id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  peer_id INT NOT NULL,
  identity_id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  username VARCHAR(191) NOT NULL,
  server_domain VARCHAR(255) NOT NULL,
  selected_difficulty INT NOT NULL,
  level DOUBLE NOT NULL,
  bpm INT NOT NULL,
  designer VARCHAR(191) NOT NULL,
  connected INT NOT NULL DEFAULT 0,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY(room_id, peer_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS plays (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  room_id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  pool VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  song_json MEDIUMTEXT NOT NULL,
  charts_json MEDIUMTEXT NOT NULL,
  participants_json MEDIUMTEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT NULL,
  end_reason VARCHAR(64) NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
CREATE INDEX plays_by_pool_end ON plays(pool, ended_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS service_settings (
  `key` VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  `value` TEXT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT IGNORE INTO service_settings(`key`, `value`, updated_at)
VALUES ('identity_required', '0', CAST(UNIX_TIMESTAMP() AS SIGNED) * 1000);

CREATE TABLE IF NOT EXISTS player_controls (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  kind VARCHAR(16) NOT NULL CHECK(kind IN ('registered','anonymous')),
  username VARCHAR(191) NOT NULL DEFAULT '',
  server_domain VARCHAR(255) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  banned_at BIGINT NULL,
  ban_reason VARCHAR(64) NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
CREATE INDEX player_controls_recent ON player_controls(last_seen_at DESC, id DESC);

INSERT IGNORE INTO player_controls(id, kind, server_domain, created_at, last_seen_at)
  SELECT id, 'registered', server_domain, created_at, updated_at FROM identities;
