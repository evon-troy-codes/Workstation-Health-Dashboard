// schema.js — the fleet server's tables, the same on D1 (Cloudflare) and
// node:sqlite (Docker); both are SQLite. Each statement is safe to run again.

const SCHEMA = [
  // One row per setting: the organization's name, the enrollment key's hash,
  // how many days of reports to keep.
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // One row per enrolled computer. Only a hash of its token is stored. grp is
  // for per-group enrollment keys later; empty for now.
  `CREATE TABLE IF NOT EXISTS devices (
     id          TEXT PRIMARY KEY,
     token_hash  TEXT NOT NULL UNIQUE,
     name        TEXT,
     grp         TEXT,
     app_version TEXT,
     enrolled_at TEXT NOT NULL,
     last_seen   TEXT,
     revoked     INTEGER NOT NULL DEFAULT 0
   )`,
  // One row per report a computer sent: the envelope's report, as JSON text.
  `CREATE TABLE IF NOT EXISTS reports (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id   TEXT NOT NULL REFERENCES devices(id),
     received_at TEXT NOT NULL,
     schema      INTEGER NOT NULL,
     app_version TEXT,
     body        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS reports_device_time ON reports (device_id, received_at)`,
];

export { SCHEMA };
