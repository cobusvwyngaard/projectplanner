import type { ActorKind } from "../../shared/types";

/** Entity types that mutate() writes. Sessions are written by auth/sessions.ts. */
export type MutableEntity = "note" | "task" | "link" | "label" | "capture" | "user" | "setting";

export interface EntitySpec {
  table: string;
  /** Primary key column */
  key: string;
  /** Every column, in schema order */
  columns: readonly string[];
  /** Columns left out of event JSON (large or internal) */
  hidden: readonly string[];
  /** Column set to the current time on every change and left out of diffs */
  touch: string | null;
  /** Column used to archive; null if the entity cannot be archived */
  archive: string | null;
  /** Columns each kind of actor may set on create and update */
  writable: Readonly<Record<ActorKind, readonly string[]>>;
  /** Values for every column except the key, created_at and the touch column */
  defaults: Readonly<Record<string, string | number | null>>;
  /** Extra columns that may be given only when creating (by an allowed creator) */
  createOnly: readonly string[];
  /** Actor kinds that may create rows */
  creators: readonly ActorKind[];
}

const NONE: readonly string[] = [];

const NOTE_FIELDS = ["title", "body", "label_id", "x", "y", "w", "h"] as const;
const TASK_FIELDS = ["title", "detail", "label_id", "assignee_id", "due_date", "status", "x", "y"] as const;

export const ENTITIES: Readonly<Record<MutableEntity, EntitySpec>> = {
  note: {
    table: "notes",
    key: "id",
    columns: ["id", "title", "body", "label_id", "x", "y", "w", "h", "created_at", "updated_at", "archived_at"],
    hidden: NONE,
    touch: "updated_at",
    archive: "archived_at",
    writable: { human: NOTE_FIELDS, claude: NOTE_FIELDS, system: NONE },
    defaults: { title: "", body: "", label_id: null, x: 0, y: 0, w: 240, h: 160, archived_at: null },
    createOnly: NONE,
    creators: ["human", "claude"],
  },
  task: {
    table: "tasks",
    key: "id",
    columns: [
      "id", "title", "detail", "label_id", "assignee_id", "due_date", "status",
      "done_at", "done_by_user_id", "x", "y", "created_at", "updated_at", "archived_at",
    ],
    hidden: NONE,
    touch: "updated_at",
    archive: "archived_at",
    writable: { human: TASK_FIELDS, claude: TASK_FIELDS, system: NONE },
    defaults: {
      title: "", detail: "", label_id: null, assignee_id: null, due_date: null, status: "open",
      done_at: null, done_by_user_id: null, x: null, y: null, archived_at: null,
    },
    createOnly: NONE,
    creators: ["human", "claude"],
  },
  link: {
    table: "links",
    key: "id",
    columns: ["id", "a_type", "a_id", "b_type", "b_id", "created_at", "archived_at"],
    hidden: NONE,
    touch: null,
    archive: "archived_at",
    // Links are made with action 'link' and removed with 'unlink'; no field updates.
    writable: { human: NONE, claude: NONE, system: NONE },
    defaults: { a_type: "note", a_id: "", b_type: "note", b_id: "", archived_at: null },
    createOnly: NONE,
    creators: ["human", "claude"],
  },
  label: {
    table: "labels",
    key: "id",
    columns: ["id", "name", "colour_hex", "sort_order", "archived_at", "created_at"],
    hidden: NONE,
    touch: null,
    archive: "archived_at",
    writable: { human: ["name", "colour_hex", "sort_order"], claude: NONE, system: NONE },
    defaults: { name: "", colour_hex: "#9ca3af", sort_order: 0, archived_at: null },
    createOnly: NONE,
    creators: ["human"],
  },
  capture: {
    table: "captures",
    key: "id",
    columns: [
      "id", "kind", "author_user_id", "r2_key", "mime", "duration_s", "text", "transcript_json",
      "transcript_status", "transcript_error", "transcribe_attempts", "transcribe_next_at",
      "inbox_status", "claimed_by_run_id", "claimed_at", "processed_by_run_id", "processed_at",
      "processing_note", "created_at",
    ],
    hidden: ["transcript_json"],
    touch: null,
    archive: null,
    writable: {
      // People edit transcripts and can move captures in or out of the inbox.
      human: ["text", "inbox_status", "processing_note"],
      claude: [
        "inbox_status", "claimed_by_run_id", "claimed_at",
        "processed_by_run_id", "processed_at", "processing_note",
      ],
      system: [
        "text", "transcript_json", "transcript_status", "transcript_error",
        "duration_s", "inbox_status", "claimed_by_run_id", "claimed_at",
      ],
    },
    defaults: {
      kind: "text", author_user_id: null, r2_key: null, mime: null, duration_s: null, text: null,
      transcript_json: null, transcript_status: "n/a", transcript_error: null, transcribe_attempts: 0,
      transcribe_next_at: null, inbox_status: "new", claimed_by_run_id: null, claimed_at: null,
      processed_by_run_id: null, processed_at: null, processing_note: null,
    },
    createOnly: ["kind", "author_user_id", "r2_key", "mime", "duration_s", "transcript_status", "inbox_status"],
    creators: ["human"],
  },
  user: {
    table: "users",
    key: "id",
    columns: ["id", "email", "display_name", "initials", "created_at"],
    hidden: NONE,
    touch: null,
    archive: null,
    writable: { human: ["display_name", "initials"], claude: NONE, system: NONE },
    defaults: { email: null, display_name: "", initials: "" },
    createOnly: NONE,
    creators: [],
  },
  setting: {
    table: "settings",
    key: "key",
    columns: ["key", "value_json"],
    hidden: NONE,
    touch: null,
    archive: null,
    writable: { human: ["value_json"], claude: NONE, system: NONE },
    defaults: { value_json: "null" },
    createOnly: ["key"],
    creators: ["human"],
  },
};

/** Entities Claude may write at all (SPEC section 5 guardrails). */
export const CLAUDE_ENTITIES: readonly MutableEntity[] = ["note", "task", "link", "capture"];
