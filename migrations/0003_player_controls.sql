CREATE TABLE IF NOT EXISTS player_controls (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('registered','anonymous')),
  username TEXT NOT NULL DEFAULT '',
  server_domain TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  banned_at INTEGER,
  ban_reason TEXT
);
CREATE INDEX IF NOT EXISTS player_controls_recent ON player_controls(last_seen_at DESC,id DESC);
INSERT OR IGNORE INTO player_controls(id,kind,server_domain,created_at,last_seen_at)
  SELECT id,'registered',server_domain,created_at,updated_at FROM identities;
