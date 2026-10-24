-- gma.4mn.org: the first schema. See docs/ARCHITECTURE.md#data-model.
-- Ids are 26-char ULIDs (except passkey credential ids). Times are integer ms
-- since the epoch, UTC. Booleans are 0/1. JSON columns hold JSON text.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed')),
  color         TEXT,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER,
  removed_at    INTEGER
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES users (id),
  name        TEXT,
  email       TEXT COLLATE NOCASE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  -- when the app emailed this invite to `email` (NULL: Ben shared the link some other way)
  sent_at     INTEGER,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by     TEXT REFERENCES users (id),
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX invites_email ON invites (email);

CREATE TABLE login_codes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash        TEXT NOT NULL,
  link_token_hash  TEXT NOT NULL UNIQUE,
  expires_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  used_at          INTEGER,
  created_at       INTEGER NOT NULL,
  ip               TEXT
);
CREATE INDEX login_codes_user_created ON login_codes (user_id, created_at);
CREATE INDEX login_codes_ip_created ON login_codes (ip, created_at);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_by    TEXT REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('user', 'device')),
  user_id       TEXT REFERENCES users (id) ON DELETE CASCADE,
  device_id     TEXT REFERENCES devices (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT,
  CHECK ((kind = 'user' AND user_id IS NOT NULL AND device_id IS NULL)
      OR (kind = 'device' AND device_id IS NOT NULL AND user_id IS NULL))
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_device ON sessions (device_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY, -- the credential id, base64url
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,             -- JSON array
  device_type   TEXT,
  backed_up     INTEGER NOT NULL DEFAULT 0,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users (id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_challenge ON webauthn_challenges (challenge);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);

CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id),
  kind            TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  caption         TEXT,
  batch_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed', 'hidden')),
  error           TEXT,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,
  original_path   TEXT,
  original_mime   TEXT,
  original_bytes  INTEGER,
  created_at      INTEGER NOT NULL,
  ready_at        INTEGER,
  hidden_at       INTEGER
);
CREATE INDEX items_status_id ON items (status, id);
CREATE INDEX items_user_id ON items (user_id, id);
CREATE INDEX items_batch ON items (batch_id);

CREATE TABLE renditions (
  item_id  TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  name     TEXT NOT NULL CHECK (name IN ('thumb', 'display', 'large', 'poster', 'video', 'audio')),
  path     TEXT NOT NULL,
  mime     TEXT NOT NULL,
  width    INTEGER,
  height   INTEGER,
  bytes    INTEGER,
  PRIMARY KEY (item_id, name)
);

CREATE TABLE voice_notes (
  id             TEXT PRIMARY KEY,
  device_id      TEXT REFERENCES devices (id),
  user_id        TEXT REFERENCES users (id),
  item_id        TEXT REFERENCES items (id) ON DELETE CASCADE, -- a family note on an upload
  status         TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  duration_ms    INTEGER,
  original_path  TEXT,
  audio_path     TEXT,
  client_id      TEXT UNIQUE,
  created_at     INTEGER NOT NULL
);
CREATE INDEX voice_notes_item ON voice_notes (item_id);

CREATE TABLE presets (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE grandma_events (
  id                 TEXT PRIMARY KEY,
  device_id          TEXT NOT NULL REFERENCES devices (id),
  kind               TEXT NOT NULL CHECK (kind IN ('reaction', 'preset', 'voice')),
  item_id            TEXT REFERENCES items (id) ON DELETE SET NULL,
  reaction           TEXT CHECK (reaction IN ('love', 'funny', 'wow', 'thankful')),
  preset_id          TEXT REFERENCES presets (id) ON DELETE SET NULL,
  preset_text        TEXT,
  voice_note_id      TEXT REFERENCES voice_notes (id) ON DELETE SET NULL,
  recipient_user_id  TEXT REFERENCES users (id), -- NULL = everyone
  client_id          TEXT UNIQUE,                -- idempotency key from the frame's outbox
  created_at         INTEGER NOT NULL
);
CREATE INDEX grandma_events_item ON grandma_events (item_id);
CREATE INDEX grandma_events_recipient ON grandma_events (recipient_user_id);

CREATE TABLE item_views (
  device_id  TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (device_id, item_id)
);

CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       INTEGER NOT NULL,
  last_success_at  INTEGER,
  failures         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'video', 'voice')),
  ref_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_after     INTEGER NOT NULL,
  locked_at     INTEGER,
  locked_by     TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs (status, kind, run_after, created_at);
CREATE INDEX jobs_ref ON jobs (ref_id);

-- The SSE outbox. Row ids are the SSE event ids (Last-Event-ID resumes after them).
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'all', -- 'all' | 'devices' | 'user:<id>' | 'device:<id>'
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX events_created ON events (created_at);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL -- JSON
);

CREATE TABLE admin_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT, -- JSON
  created_at  INTEGER NOT NULL
);
CREATE INDEX admin_log_created ON admin_log (created_at);

-- Seed: the eight preset messages (DECISIONS.md, 2026-10-22) and the default settings.
INSERT INTO presets (id, text, sort, active, created_at) VALUES
  ('01M5GEGM00FFBC4TAMAWYG9Q1V', 'Love you',        1, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q1W', 'Call me',         2, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q1X', 'Thank you',       3, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q1Y', 'Miss you all',    4, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q1Z', 'So beautiful',    5, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q20', 'Made my day',     6, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q21', 'Come visit soon', 7, 1, 1792627200000),
  ('01M5GEGM00FFBC4TAMAWYG9Q22', 'Proud of you',    8, 1, 1792627200000);

INSERT INTO settings (key, value) VALUES
  ('night_start', '"21:00"'),
  ('night_end', '"07:00"'),
  ('timezone', '"America/Chicago"'),
  ('max_video_seconds', '180'),
  ('max_voice_seconds', '60');
