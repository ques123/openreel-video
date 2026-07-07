-- Initial schema (contracts §3). Applied inside a transaction by db.ts's
-- migration runner, which then bumps PRAGMA user_version to 1.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  invite_id TEXT,
  quota_overrides TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  frames INTEGER,
  seconds REAL,
  units INTEGER,
  actual_cost_usd REAL,
  upstream_status INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX idx_usage_events_user_at ON usage_events(user_id, at);
CREATE INDEX idx_usage_events_at ON usage_events(at);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE telemetry_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  data TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_telemetry_events_at ON telemetry_events(at);
CREATE INDEX idx_telemetry_events_user_at ON telemetry_events(user_id, at);
