// Request and response shapes of the app API (/api/*). The Worker and the
// browser app both import these, so a change here is a change to both.
//
// Errors: every non-2xx JSON response has the shape ApiErrorBody.
// 401 means "no valid session": the app sends the browser to /login.

import type {
  Capture,
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
  User,
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
