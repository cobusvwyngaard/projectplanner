// Request and response shapes of the app API (/api/*). The Worker and the
// browser app both import these, so a change here is a change to both.
//
// Errors: every non-2xx JSON response has the shape ApiErrorBody.
// 401 means "no valid session": the app sends the browser to /login.

import type {
  Capture,
  CaptureAttachment,
  EventAction,
  Id,
  ItemRef,
  Label,
  Link,
  LocalDate,
  NoteView,
  PlannerEvent,
  Run,
  Session,
  SettingKey,
  SettingsMap,
  TaskView,
  Timestamp,
  User,
  UserEmail,
} from "./types";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Result of any single change: the row afterwards and the event (null if nothing changed). */
export interface MutationResponse<T> {
  row: T;
  event: PlannerEvent | null;
}

// --- Bootstrap and change feed ---------------------------------------------

/** GET /api/bootstrap */
export interface BootstrapResponse {
  me: User;
  users: User[];
  /** Every registered email address, archived ones included (SPEC 11.2) */
  user_emails: UserEmail[];
  /** All labels, archived ones included (archived_at set) so old items still render */
  labels: Label[];
  /** Notes that are not archived */
  notes: NoteView[];
  /** Tasks that are not archived (open and done) */
  tasks: TaskView[];
  /** Links that are not archived */
  links: Link[];
  settings: SettingsMap;
  /** Id of the newest event; pass to /api/changes as `since` */
  cursor: Id | null;
  /** Today in Africa/Johannesburg */
  today: LocalDate;
}

/**
 * GET /api/changes?since=<event_id>
 * Events after `since` (oldest first, at most 500) and the current state of
 * every row they touched. Rows are included even when archived, so the app
 * can drop them. If `since` is unknown, `reset` is true and the app reloads
 * /api/bootstrap.
 */
export interface ChangesResponse {
  events: PlannerEvent[];
  notes: NoteView[];
  tasks: TaskView[];
  links: Link[];
  labels: Label[];
  users: User[];
  /** Registered email addresses, archived ones included */
  user_emails: UserEmail[];
  /** Attachments of the captures the events touched */
  attachments: CaptureAttachment[];
  /** Present when any setting changed */
  settings: SettingsMap | null;
  captures: Capture[];
  cursor: Id | null;
  /** True when more events are waiting; poll again straight away */
  more: boolean;
  reset: boolean;
}

// --- Notes, tasks, links ---------------------------------------------------

/** POST /api/notes */
export interface CreateNoteRequest {
  title?: string;
  body?: string;
  label_id?: Id | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** PATCH /api/notes/:id */
export type UpdateNoteRequest = CreateNoteRequest;

/** POST /api/tasks */
export interface CreateTaskRequest {
  title: string;
  detail?: string;
  label_id?: Id | null;
  assignee_id?: Id | null;
  due_date?: LocalDate | null;
  /** Both or neither; omitted means the task starts in the tray */
  x?: number | null;
  y?: number | null;
}

/** PATCH /api/tasks/:id — status changes are recorded as complete/reopen */
export interface UpdateTaskRequest extends Partial<CreateTaskRequest> {
  status?: "open" | "done";
}

// POST /api/notes/:id/archive, /unarchive
// POST /api/tasks/:id/complete, /reopen, /archive, /unarchive
//   -> MutationResponse<NoteView | TaskView>

/** POST /api/links -> MutationResponse<Link> */
export interface CreateLinkRequest {
  a: ItemRef;
  b: ItemRef;
}
// POST /api/links/:id/unlink -> MutationResponse<Link>

// --- Labels, users, settings ----------------------------------------------

/** POST /api/labels -> MutationResponse<Label> */
export interface CreateLabelRequest {
  name: string;
  /** #rrggbb, any case; stored lower-case */
  colour_hex: string;
}

/** PATCH /api/labels/:id -> MutationResponse<Label> */
export type UpdateLabelRequest = Partial<CreateLabelRequest>;

/** POST /api/labels/reorder -> { labels: Label[] } (all labels, new order) */
export interface ReorderLabelsRequest {
  /** Label ids in the wanted order; sort_order becomes the index */
  ids: Id[];
}
// POST /api/labels/:id/archive, /unarchive -> MutationResponse<Label>

/** PATCH /api/users/:id -> MutationResponse<User> */
export interface UpdateUserRequest {
  display_name?: string;
  initials?: string;
}

/** POST /api/users/:id/emails -> 201 MutationResponse<UserEmail> (SPEC 11.2) */
export interface CreateUserEmailRequest {
  /** Trimmed and lower-cased before it is stored */
  address: string;
}
// POST /api/user-emails/:id/archive -> MutationResponse<UserEmail>

/** PUT /api/settings/:key -> { settings: SettingsMap } */
export interface UpdateSettingRequest<K extends SettingKey = SettingKey> {
  value: SettingsMap[K];
}

// --- Sessions (Settings > Signed-in browsers) -----------------------------

export interface SessionView extends Session {
  /** True for the browser making the request */
  current: boolean;
}

/** GET /api/sessions — active (not revoked) sessions of both users */
export interface SessionsResponse {
  sessions: SessionView[];
}
// POST /api/sessions/:id/revoke     -> { ok: true }  (any active session)
// POST /api/sessions/revoke-mine    -> { ok: true }  (every session of the signed-in user, this one included)
// POST /api/sessions/revoke-current -> { ok: true }  (this browser; the cookie is cleared)

// --- Claude connections (Settings > Claude connections) --------------------

/** One OAuth grant Claude holds: who allowed it, which client, and when. */
export interface ClaudeConnectionView {
  /** The grant's id, which disconnect takes */
  id: Id;
  /** The person Claude acts for */
  user_id: Id;
  /** The client's own name, or "Unnamed client" */
  client_name: string;
  connected_at: Timestamp;
}

/** GET /api/claude-connections — every connection any person has granted, newest first */
export interface ClaudeConnectionsResponse {
  connections: ClaudeConnectionView[];
}
// POST /api/claude-connections/:userId/:grantId/disconnect -> { ok: true }

// --- Activity, history, revert, runs --------------------------------------

/**
 * GET /api/events?actor=human|claude|system&user_id=&run_id=&from=&to=&entity_type=&entity_id=&before=&limit=
 * Newest first. from/to are local dates (inclusive). before is a seq for paging.
 */
export interface EventsResponse {
  events: PlannerEvent[];
  /** Runs referenced by the events */
  runs: Run[];
  /** Display titles of the entities the events refer to, keyed "type:id" */
  titles: Record<string, string>;
  /** Pass as `before` for the next page; null at the end */
  next: number | null;
}

/**
 * GET /api/history/:type/:id — the item's events oldest first, including link
 * events that involve it, plus the runs and source captures they refer to.
 */
export interface HistoryResponse {
  events: PlannerEvent[];
  runs: Run[];
  captures: Capture[];
  titles: Record<string, string>;
}

/** POST /api/events/:id/revert and POST /api/runs/:id/revert */
export interface RevertRequest {
  /** Required when later changes touched the same fields */
  confirm?: boolean;
}

export interface RevertResponse {
  /** Number of events that changed something */
  reverted: number;
  events: PlannerEvent[];
}

/** One conflict reported with a 409 { error: { code: "revert_conflict", details: { conflicts } } } */
export interface RevertConflictView {
  event_id: Id;
  field: string;
  later_event: PlannerEvent;
}

export interface RunView extends Run {
  event_count: number;
  capture_ids: Id[];
}

/** GET /api/runs?before=<started_at>&limit= — newest first */
export interface RunsResponse {
  runs: RunView[];
}

/** GET /api/runs/:id */
export interface RunDetailResponse {
  run: RunView;
  events: PlannerEvent[];
  captures: Capture[];
  titles: Record<string, string>;
}

// --- Captures and the inbox (phase 2) -------------------------------------

/**
 * POST /api/captures, multipart/form-data -> 201 MutationResponse<Capture>
 *   kind = "text":          field "text" (1..20 000 characters)
 *   kind = "voice" | "file": field "file" (audio, at most 50 MB) and optionally
 *                           "duration_s" (seconds, as measured by the browser)
 * Voice and file captures start with transcript_status "pending"; text
 * captures with "n/a". All start in the inbox (inbox_status "new").
 */
export type CaptureKindField = "voice" | "file" | "text";

/** Why transcription cannot work at the moment, for a banner in the Inbox. */
export type TranscriptionProblem = "missing_key" | "bad_key" | null;

/**
 * GET /api/captures?status=new|claimed|processed|ignored|all&before=<created_at>&limit=
 * Newest first; status defaults to "all"; limit 1..100, default 30.
 */
export interface CapturesResponse {
  captures: Capture[];
  /** Runs that claimed or processed the listed captures */
  runs: Run[];
  /** Pass as `before` for the next page; null at the end */
  next: string | null;
  transcription: { problem: TranscriptionProblem };
}

/** An item a run created or changed, listed under the capture it processed. */
export interface CaptureItemRef {
  type: "note" | "task" | "link";
  id: Id;
  title: string;
  /** What the run did to it, oldest first */
  actions: EventAction[];
}

/** GET /api/captures/:id */
export interface CaptureDetailResponse {
  capture: Capture;
  /** The runs that claimed or processed it */
  runs: Run[];
  /** Attachments of an email capture, listed even when too large to store */
  attachments: CaptureAttachment[];
  /** Items those runs created or changed, from their events */
  items: CaptureItemRef[];
  /** The capture's own events, oldest first */
  events: PlannerEvent[];
}

/**
 * PATCH /api/captures/:id -> MutationResponse<Capture>
 * A transcript edit is a person's event on the capture (SPEC 6.2). People may
 * move a capture between new, ignored and processed, but not while a Claude
 * run has it claimed (409).
 */
export interface UpdateCaptureRequest {
  text?: string;
  inbox_status?: "new" | "ignored" | "processed";
  processing_note?: string | null;
}

// POST /api/captures/:id/retry -> 202 { capture: Capture }   (voice/file captures that are pending or failed)
// GET|HEAD /api/captures/:id/audio -> the audio, with Range support (206/416)
