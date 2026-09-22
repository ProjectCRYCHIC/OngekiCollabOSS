CREATE TABLE IF NOT EXISTS service_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO service_settings(key, value, updated_at)
VALUES ('identity_required', '0', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
