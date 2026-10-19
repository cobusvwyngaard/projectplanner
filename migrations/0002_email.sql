-- Phase 4A: email capture (SPEC section 11).
-- Nothing references captures by foreign key, so the table can be rebuilt to
-- widen its CHECK constraints (SQLite cannot alter a CHECK in place).

CREATE TABLE captures_new (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('voice','text','file','email')),
  -- Null for an email capture whose sender was not verified (SPEC 11.2).
  author_user_id      TEXT REFERENCES users(id),
  r2_key              TEXT,
  mime                TEXT,
  duration_s          REAL,
  text                TEXT,
  transcript_json     TEXT,
  transcript_status   TEXT NOT NULL CHECK (transcript_status IN ('n/a','pending','done','failed')),
  transcript_error    TEXT,
  transcribe_attempts INTEGER NOT NULL DEFAULT 0,
  -- Earliest time the next attempt may start; for email captures it leases the
  -- read step the same way it leases transcription (see DECISIONS.md).
  transcribe_next_at  TEXT,
  inbox_status        TEXT NOT NULL CHECK (inbox_status IN ('new','claimed','processed','ignored')),
  claimed_by_run_id   TEXT REFERENCES runs(id),
  claimed_at          TEXT,
  processed_by_run_id TEXT REFERENCES runs(id),
  processed_at        TEXT,
  processing_note     TEXT,
  created_at          TEXT NOT NULL,
  -- Email fields (SPEC 11.3). Only a verified sender yields author_user_id.
  email_subject       TEXT,
  email_from          TEXT,
  email_to_json       TEXT,
  email_cc_json       TEXT,
  email_participants_json TEXT,
  email_message_id    TEXT,
  email_sender_verified INTEGER CHECK (email_sender_verified IN (0,1)),
  CHECK (kind = 'email' OR author_user_id IS NOT NULL)
);

INSERT INTO captures_new (
  id, kind, author_user_id, r2_key, mime, duration_s, text, transcript_json,
  transcript_status, transcript_error, transcribe_attempts, transcribe_next_at,
  inbox_status, claimed_by_run_id, claimed_at, processed_by_run_id, processed_at,
  processing_note, created_at
)
SELECT
  id, kind, author_user_id, r2_key, mime, duration_s, text, transcript_json,
  transcript_status, transcript_error, transcribe_attempts, transcribe_next_at,
  inbox_status, claimed_by_run_id, claimed_at, processed_by_run_id, processed_at,
  processing_note, created_at
FROM captures;

DROP TABLE captures;
ALTER TABLE captures_new RENAME TO captures;

CREATE INDEX captures_inbox ON captures(inbox_status, created_at);
CREATE INDEX captures_transcript ON captures(transcript_status, transcribe_next_at);
CREATE INDEX captures_claimed ON captures(claimed_by_run_id);
-- Duplicate Message-IDs are ignored (SPEC 11.3), so at most one capture may
-- hold a given Message-ID. Captures without one are left alone.
CREATE UNIQUE INDEX captures_email_message_id ON captures(email_message_id)
  WHERE email_message_id IS NOT NULL;

-- One registered address per person, address stored lower-case. Archiving frees
-- the address for reuse (SPEC 11.2).
CREATE TABLE user_emails (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  address     TEXT NOT NULL CHECK (address = lower(address)),
  created_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX user_emails_address_open ON user_emails(address) WHERE archived_at IS NULL;

-- Carry any address already set on a person over to the new table.
INSERT INTO user_emails (id, user_id, address, created_at, archived_at)
SELECT 'email-' || id, id, lower(email), '2026-01-01T00:00:00.000Z', NULL
FROM users
WHERE email IS NOT NULL;

-- Attachments of an email capture (SPEC 11.3). At most 20 are stored; the rest
-- are listed with r2_key NULL and too_large 1.
CREATE TABLE capture_attachments (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  r2_key      TEXT,
  too_large   INTEGER NOT NULL CHECK (too_large IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX capture_attachments_capture ON capture_attachments(capture_id);
