// Row and view types shared by the Worker and the browser app.
// Column names follow the D1 schema (migrations/) exactly.

export type Id = string;
/** UTC ISO timestamp, e.g. 2026-10-14T08:30:00.000Z */
export type Timestamp = string;
/** Plain local date in Africa/Johannesburg, YYYY-MM-DD */
export type LocalDate = string;

export interface User {
  id: Id;
  email: string | null;
  display_name: string;
  initials: string;
  created_at: Timestamp;
}

export interface Label {
  id: Id;
  name: string;
  /** Lower-case #rrggbb */
  colour_hex: string;
  sort_order: number;
  archived_at: Timestamp | null;
  created_at: Timestamp;
}

export interface Note {
  id: Id;
  title: string;
  body: string;
  label_id: Id | null;
  x: number;
  y: number;
  w: number;
  h: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export type TaskStatus = "open" | "done";

export interface Task {
  id: Id;
  title: string;
  detail: string;
  label_id: Id | null;
  assignee_id: Id | null;
  due_date: LocalDate | null;
  status: TaskStatus;
  done_at: Timestamp | null;
  done_by_user_id: Id | null;
  /** null when the task is not placed on the canvas (it sits in the tray) */
  x: number | null;
  y: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export type ItemType = "note" | "task";

export interface ItemRef {
  type: ItemType;
  id: Id;
}

export interface Link {
  id: Id;
  a_type: ItemType;
  a_id: Id;
  b_type: ItemType;
  b_id: Id;
  created_at: Timestamp;
  archived_at: Timestamp | null;
}

export type CaptureKind = "voice" | "text" | "file" | "email";
export type TranscriptStatus = "n/a" | "pending" | "done" | "failed";
export type InboxStatus = "new" | "claimed" | "processed" | "ignored";

/** One person in an email: how the message named them and the planner user they map to. */
export interface EmailParticipant {
  address: string;
  name: string;
  role: "from" | "to" | "cc";
  /** The planner user this address belongs to, or null when it maps to nobody */
  user_id: Id | null;
}

/** A registered email address of a person (SPEC 11.2). */
export interface UserEmail {
  id: Id;
  user_id: Id;
  /** Lower-case; one open row per address */
  address: string;
  created_at: Timestamp;
  archived_at: Timestamp | null;
}

/** One attachment of an email capture, listed even when it was not stored. */
export interface CaptureAttachment {
  id: Id;
  capture_id: Id;
  filename: string;
  mime: string;
  size_bytes: number;
  /** R2 key of the stored content, or null when too_large is 1 */
  r2_key: string | null;
  too_large: 0 | 1;
  created_at: Timestamp;
}

/** A capture as the app sees it. transcript_json is never sent to the browser. */
export interface Capture {
  id: Id;
  kind: CaptureKind;
  /** Null only for an email capture whose sender was not verified (SPEC 11.2) */
  author_user_id: Id | null;
  r2_key: string | null;
  mime: string | null;
  duration_s: number | null;
  text: string | null;
  transcript_status: TranscriptStatus;
  transcript_error: string | null;
  transcribe_attempts: number;
  transcribe_next_at: Timestamp | null;
  inbox_status: InboxStatus;
  claimed_by_run_id: Id | null;
  claimed_at: Timestamp | null;
  processed_by_run_id: Id | null;
  processed_at: Timestamp | null;
  processing_note: string | null;
  created_at: Timestamp;
  email_subject: string | null;
  email_from: string | null;
  /** JSON array of addresses, as sent */
  email_to_json: string | null;
  email_cc_json: string | null;
  /** JSON array of EmailParticipant */
  email_participants_json: string | null;
  email_message_id: string | null;
  /** 1 when the sender was verified (SPEC 11.2), 0 when not, null for other kinds */
  email_sender_verified: 0 | 1 | null;
}

export interface Run {
  id: Id;
  user_id: Id;
  intent: string;
  summary: string | null;
  started_at: Timestamp;
  finished_at: Timestamp | null;
}

export type ActorKind = "human" | "claude" | "system";

export type EntityType =
  | "note"
  | "task"
  | "link"
  | "label"
  | "capture"
  | "user"
  | "setting"
  | "user_email"
  | "attachment"
  | "session"
  | "claude_connection";

export type EventAction =
  | "create"
  | "update"
  | "archive"
  | "unarchive"
  | "complete"
  | "reopen"
  | "link"
  | "unlink"
  | "revert"
  | "login"
  | "session_revoke";

/** One row of the append-only events table, with JSON columns parsed. */
export interface PlannerEvent {
  seq: number;
  id: Id;
  ts: Timestamp;
  actor_kind: ActorKind;
  actor_user_id: Id | null;
  run_id: Id | null;
  entity_type: EntityType;
  entity_id: Id;
  action: EventAction;
  /** Values of the changed fields before the change (null for create) */
  before: Record<string, unknown> | null;
  /** Values of the changed fields after the change (the full row for create) */
  after: Record<string, unknown> | null;
  source_capture_ids: Id[] | null;
  reverts_event_id: Id | null;
}

/** Who did something: a person, Claude on a person's behalf, or the system. */
export interface ActorRef {
  kind: ActorKind;
  user_id: Id | null;
}

/** Who created an item and who last changed it, derived from events. */
export interface Provenance {
  created_by: ActorRef;
  created_at: Timestamp;
  changed_by: ActorRef;
  changed_at: Timestamp;
}

export interface NoteView extends Note {
  prov: Provenance | null;
}

/** Why a task counts as coming from outside: its sender was not a planner person, or was one whose address failed verification. */
export type FromOutside = "unregistered" | "unverified";

export interface TaskView extends Task {
  prov: Provenance | null;
  /** Set when a source capture of the task is an email from outside (SPEC section 5) */
  from_outside: FromOutside | null;
}

export interface Session {
  id: Id;
  user_id: Id;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  user_agent: string | null;
  revoked_at: Timestamp | null;
}

/** Settings known to the app. Stored as JSON in the settings table. */
export interface SettingsMap {
  stt_keyterms: string[];
  stt_keyterms_enabled: boolean;
  default_label_id: Id | null;
}

export type SettingKey = keyof SettingsMap;
