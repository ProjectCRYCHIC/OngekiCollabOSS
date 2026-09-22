CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  keychip_hash TEXT NOT NULL,
  access_hash TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  server_hash TEXT NOT NULL,
  composite_hash TEXT NOT NULL UNIQUE,
  server_domain TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_keychip_binding ON identities(keychip_hash);
CREATE UNIQUE INDEX IF NOT EXISTS identities_access_binding ON identities(access_hash);
CREATE UNIQUE INDEX IF NOT EXISTS identities_user_binding ON identities(user_hash);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY(identity_id) REFERENCES identities(id)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  music_id INTEGER NOT NULL,
  game_version TEXT NOT NULL,
  status TEXT NOT NULL,
  song_json TEXT NOT NULL,
  charts_json TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 4,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_by_pool_status ON rooms(pool,status,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  peer_id INTEGER NOT NULL,
  identity_id TEXT NOT NULL,
  username TEXT NOT NULL,
  server_domain TEXT NOT NULL,
  selected_difficulty INTEGER NOT NULL,
  level REAL NOT NULL,
  bpm INTEGER NOT NULL,
  designer TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,peer_id)
);
CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  pool TEXT NOT NULL,
  song_json TEXT NOT NULL,
  charts_json TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS plays_by_pool_end ON plays(pool,ended_at DESC,id DESC);
