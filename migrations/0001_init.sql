-- Shared planner schema (SPEC section 4).
-- IDs are ULIDs, timestamps are UTC ISO strings, due dates are YYYY-MM-DD.
-- Nothing is hard-deleted; rows are archived with archived_at.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  display_name TEXT NOT NULL,
  initials     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- The two users. LOGIN_PHRASE_1 signs in as the first, LOGIN_PHRASE_2 as the
-- second (src/worker/auth/phrase.ts). Names are changed in Settings.
INSERT INTO users (id, email, display_name, initials, created_at) VALUES
  ('00000000000000000000000001', NULL, 'Person 1', 'P1', '2026-01-01T00:00:00.000Z'),
  ('00000000000000000000000002', NULL, 'Person 2', 'P2', '2026-01-01T00:00:00.000Z');

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  ip           TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  lockouts     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  colour_hex  TEXT NOT NULL CHECK (colour_hex GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  label_id    TEXT REFERENCES labels(id),
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  w           REAL NOT NULL DEFAULT 240,
  h           REAL NOT NULL DEFAULT 160,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '',
  label_id        TEXT REFERENCES labels(id),
  assignee_id     TEXT REFERENCES users(id),
  due_date        TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  done_at         TEXT,
  done_by_user_id TEXT REFERENCES users(id),
  x               REAL,
  y               REAL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  CHECK ((x IS NULL) = (y IS NULL))
);
CREATE INDEX tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX tasks_due ON tasks(due_date);

-- Links are stored with the endpoints in a canonical order (src/worker/mutate)
-- so a pair can only be linked once, whichever way round it was drawn.
CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  a_type      TEXT NOT NULL CHECK (a_type IN ('note','task')),
  a_id        TEXT NOT NULL,
  b_type      TEXT NOT NULL CHECK (b_type IN ('note','task')),
  b_id        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (a_type, a_id, b_type, b_id),
  CHECK (NOT (a_type = b_type AND a_id = b_id))
);
CREATE INDEX links_b ON links(b_type, b_id);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  intent      TEXT NOT NULL,
  summary     TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX runs_open ON runs(finished_at, started_at);

CREATE TABLE captures (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('voice','text','file')),
  author_user_id      TEXT NOT NULL REFERENCES users(id),
  r2_key              TEXT,
  mime                TEXT,
  duration_s          REAL,
  text                TEXT,
  transcript_json     TEXT,
  transcript_status   TEXT NOT NULL CHECK (transcript_status IN ('n/a','pending','done','failed')),
  transcript_error    TEXT,
  transcribe_attempts INTEGER NOT NULL DEFAULT 0,
  -- Earliest time the next transcription attempt may start (retry backoff
  -- and a lease so the cron and the upload request never overlap).
  transcribe_next_at  TEXT,
  inbox_status        TEXT NOT NULL CHECK (inbox_status IN ('new','claimed','processed','ignored')),
  claimed_by_run_id   TEXT REFERENCES runs(id),
  claimed_at          TEXT,
  processed_by_run_id TEXT REFERENCES runs(id),
  processed_at        TEXT,
  processing_note     TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX captures_inbox ON captures(inbox_status, created_at);
CREATE INDEX captures_transcript ON captures(transcript_status, transcribe_next_at);
CREATE INDEX captures_claimed ON captures(claimed_by_run_id);

-- APPEND-ONLY. seq gives the commit order used by the change feed; id is the
-- public ULID. The triggers below refuse any UPDATE or DELETE.
CREATE TABLE events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  ts                 TEXT NOT NULL,
  actor_kind         TEXT NOT NULL CHECK (actor_kind IN ('human','claude','system')),
  actor_user_id      TEXT REFERENCES users(id),
  run_id             TEXT REFERENCES runs(id),
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  action             TEXT NOT NULL CHECK (action IN ('create','update','archive','unarchive','complete','reopen','link','unlink','revert','login','session_revoke')),
  before_json        TEXT,
  after_json         TEXT,
  source_capture_ids TEXT,
  reverts_event_id   TEXT REFERENCES events(id),
  CHECK (actor_kind <> 'claude' OR (run_id IS NOT NULL AND actor_user_id IS NOT NULL)),
  CHECK (actor_kind <> 'human' OR actor_user_id IS NOT NULL),
  CHECK (action <> 'revert' OR reverts_event_id IS NOT NULL)
);
CREATE INDEX events_entity ON events(entity_type, entity_id, seq);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_actor ON events(actor_kind, actor_user_id, seq);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_reverts ON events(reverts_event_id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
INSERT INTO settings (key, value_json) VALUES
  ('stt_keyterms', '[]'),
  ('stt_keyterms_enabled', 'false'),
  ('default_label_id', 'null');

-- Write guards. A batch inserts (expected, actual) after a conditional write,
-- usually with actual = changes(). A match is silently dropped; a mismatch
-- aborts the statement, and with it the whole db.batch() transaction.
CREATE TABLE write_guard (
  expected INTEGER NOT NULL,
  actual   INTEGER NOT NULL,
  reason   TEXT NOT NULL
);

CREATE TRIGGER write_guard_ok BEFORE INSERT ON write_guard
WHEN NEW.expected = NEW.actual
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER write_guard_stale BEFORE INSERT ON write_guard
WHEN NEW.expected <> NEW.actual AND NEW.reason = 'stale'
BEGIN
  SELECT RAISE(ABORT, 'write_guard:stale');
END;

CREATE TRIGGER write_guard_run BEFORE INSERT ON write_guard
WHEN NEW.expected <> NEW.actual AND NEW.reason = 'run'
BEGIN
  SELECT RAISE(ABORT, 'write_guard:run');
END;

CREATE TRIGGER write_guard_claim BEFORE INSERT ON write_guard
WHEN NEW.expected <> NEW.actual AND NEW.reason = 'claim'
BEGIN
  SELECT RAISE(ABORT, 'write_guard:claim');
END;

CREATE TRIGGER write_guard_other BEFORE INSERT ON write_guard
WHEN NEW.expected <> NEW.actual AND NEW.reason NOT IN ('stale','run','claim')
BEGIN
  SELECT RAISE(ABORT, 'write_guard:other');
END;

-- Storage for @cloudflare/workers-oauth-provider (clients, grants, tokens),
-- used through a KV-compatible adapter so the app needs only D1 and R2.
CREATE TABLE oauth_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  metadata   TEXT
);
CREATE INDEX oauth_kv_expires ON oauth_kv(expires_at);
