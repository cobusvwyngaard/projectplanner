// Typed client for the app API (/api/*, contract in src/shared/api.ts).
// Every request is same-origin with the session cookie. A 401 means the
// session has ended: the browser goes to the phrase page and comes back here.

import type {
  ApiErrorBody,
  BootstrapResponse,
  CaptureDetailResponse,
  CapturesResponse,
  ChangesResponse,
  ClaudeConnectionsResponse,
  CreateLabelRequest,
  CreateLinkRequest,
  CreateNoteRequest,
  CreateTaskRequest,
  CreateUserEmailRequest,
  EventsResponse,
  HistoryResponse,
  MutationResponse,
  ReorderLabelsRequest,
  RevertConflictView,
  RevertResponse,
  RunDetailResponse,
  RunsResponse,
  SessionsResponse,
  UpdateLabelRequest,
  UpdateNoteRequest,
  UpdateTaskRequest,
  UpdateCaptureRequest,
  UpdateUserRequest,
} from "../shared/api";
import type {
  ActorKind,
  Capture,
  EntityType,
  Id,
  Label,
  Link,
  LocalDate,
  NoteView,
  SettingKey,
  SettingsMap,
  TaskView,
  Timestamp,
  User,
  UserEmail,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The phrase page, returning to the current address afterwards. */
export function loginUrl(location: Pick<Location, "pathname" | "search">): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export type QueryValue = string | number | null | undefined;

/** "?a=1&b=x" from the given values, leaving out empty ones; "" when nothing is left. */
export function queryString(query: Readonly<Record<string, QueryValue>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

async function errorFrom(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON (a proxy page, an empty body): fall through to the generic message.
  }
  if (isErrorBody(body)) {
    return new ApiError(response.status, body.error.code, body.error.message, body.error.details);
  }
  return new ApiError(response.status, "http_error", `The planner answered with an error (${response.status}). Please try again.`);
}

interface RequestOptions {
  body?: unknown;
  query?: Readonly<Record<string, QueryValue>>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT";

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(path + queryString(options.query ?? {}), init);
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the planner. Check your connection and try again.");
  }
  if (response.status === 401) {
    window.location.assign(loginUrl(window.location));
    throw new ApiError(401, "signed_out", "Your session has ended. Please sign in again.");
  }
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

const seg = encodeURIComponent;

/** Upload a multipart capture with XHR so progress can be reported. */
function uploadCapture(form: FormData, onProgress?: (progress: number) => void): Promise<MutationResponse<Capture>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/captures");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON.
      }
      if (xhr.status === 401) {
        window.location.assign(loginUrl(window.location));
        reject(new ApiError(401, "signed_out", "Your session has ended. Please sign in again."));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as MutationResponse<Capture>);
        return;
      }
      if (isErrorBody(body)) {
        reject(new ApiError(xhr.status, body.error.code, body.error.message, body.error.details));
        return;
      }
      reject(new ApiError(xhr.status, "http_error", `The planner answered with an error (${xhr.status}). Please try again.`));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Could not reach the planner. Check your connection and try again."));
    xhr.send(form);
  });
}

/** Filters of GET /api/events (all optional). */
export interface EventsQuery {
  actor?: ActorKind;
  user_id?: Id;
  run_id?: Id;
  /** First local date, inclusive */
  from?: LocalDate;
  /** Last local date, inclusive */
  to?: LocalDate;
  entity_type?: EntityType;
  entity_id?: Id;
  /** A seq: only older events (paging) */
  before?: number;
  limit?: number;
}

/** Kinds of item with a history panel. */
export type HistoryType = "note" | "task" | "label" | "capture";

export interface Ok {
  ok: true;
}

export const api = {
  bootstrap: () => request<BootstrapResponse>("GET", "/api/bootstrap"),
  changes: (since: Id | null) => request<ChangesResponse>("GET", "/api/changes", { query: { since } }),

  createNote: (body: CreateNoteRequest) => request<MutationResponse<NoteView>>("POST", "/api/notes", { body }),
  updateNote: (id: Id, body: UpdateNoteRequest) =>
    request<MutationResponse<NoteView>>("PATCH", `/api/notes/${seg(id)}`, { body }),
  archiveNote: (id: Id) => request<MutationResponse<NoteView>>("POST", `/api/notes/${seg(id)}/archive`),
  unarchiveNote: (id: Id) => request<MutationResponse<NoteView>>("POST", `/api/notes/${seg(id)}/unarchive`),

  createTask: (body: CreateTaskRequest) => request<MutationResponse<TaskView>>("POST", "/api/tasks", { body }),
  updateTask: (id: Id, body: UpdateTaskRequest) =>
    request<MutationResponse<TaskView>>("PATCH", `/api/tasks/${seg(id)}`, { body }),
  completeTask: (id: Id) => request<MutationResponse<TaskView>>("POST", `/api/tasks/${seg(id)}/complete`),
  reopenTask: (id: Id) => request<MutationResponse<TaskView>>("POST", `/api/tasks/${seg(id)}/reopen`),
  archiveTask: (id: Id) => request<MutationResponse<TaskView>>("POST", `/api/tasks/${seg(id)}/archive`),
  unarchiveTask: (id: Id) => request<MutationResponse<TaskView>>("POST", `/api/tasks/${seg(id)}/unarchive`),

  createLink: (body: CreateLinkRequest) => request<MutationResponse<Link>>("POST", "/api/links", { body }),
  unlink: (id: Id) => request<MutationResponse<Link>>("POST", `/api/links/${seg(id)}/unlink`),

  createLabel: (body: CreateLabelRequest) => request<MutationResponse<Label>>("POST", "/api/labels", { body }),
  updateLabel: (id: Id, body: UpdateLabelRequest) =>
    request<MutationResponse<Label>>("PATCH", `/api/labels/${seg(id)}`, { body }),
  reorderLabels: (body: ReorderLabelsRequest) => request<{ labels: Label[] }>("POST", "/api/labels/reorder", { body }),
  archiveLabel: (id: Id) => request<MutationResponse<Label>>("POST", `/api/labels/${seg(id)}/archive`),
  unarchiveLabel: (id: Id) => request<MutationResponse<Label>>("POST", `/api/labels/${seg(id)}/unarchive`),

  updateUser: (id: Id, body: UpdateUserRequest) =>
    request<MutationResponse<User>>("PATCH", `/api/users/${seg(id)}`, { body }),

  createUserEmail: (userId: Id, body: CreateUserEmailRequest) =>
    request<MutationResponse<UserEmail>>("POST", `/api/users/${seg(userId)}/emails`, { body }),
  archiveUserEmail: (id: Id) => request<MutationResponse<UserEmail>>("POST", `/api/user-emails/${seg(id)}/archive`),

  updateSetting: <K extends SettingKey>(key: K, value: SettingsMap[K]) =>
    request<{ settings: SettingsMap }>("PUT", `/api/settings/${seg(key)}`, { body: { value } }),

  sessions: () => request<SessionsResponse>("GET", "/api/sessions"),
  revokeSession: (id: Id) => request<Ok>("POST", `/api/sessions/${seg(id)}/revoke`),
  revokeMySessions: () => request<Ok>("POST", "/api/sessions/revoke-mine"),
  revokeCurrentSession: () => request<Ok>("POST", "/api/sessions/revoke-current"),

  claudeConnections: () => request<ClaudeConnectionsResponse>("GET", "/api/claude-connections"),
  disconnectClaude: (userId: Id, grantId: Id) =>
    request<Ok>("POST", `/api/claude-connections/${seg(userId)}/${seg(grantId)}/disconnect`),

  events: (query: EventsQuery) => request<EventsResponse>("GET", "/api/events", { query: { ...query } }),
  history: (type: HistoryType, id: Id) => request<HistoryResponse>("GET", `/api/history/${seg(type)}/${seg(id)}`),
  revertEvent: (id: Id, confirm = false) =>
    request<RevertResponse>("POST", `/api/events/${seg(id)}/revert`, { body: confirm ? { confirm: true } : {} }),

  runs: (query: { before?: Timestamp; limit?: number } = {}) =>
    request<RunsResponse>("GET", "/api/runs", { query: { ...query } }),
  run: (id: Id) => request<RunDetailResponse>("GET", `/api/runs/${seg(id)}`),
  revertRun: (id: Id, confirm = false) =>
    request<RevertResponse>("POST", `/api/runs/${seg(id)}/revert`, { body: confirm ? { confirm: true } : {} }),

  captures: (query: { status?: string; before?: string; limit?: number } = {}) =>
    request<CapturesResponse>("GET", "/api/captures", { query: { ...query } }),
  capture: (id: Id) => request<CaptureDetailResponse>("GET", `/api/captures/${seg(id)}`),
  updateCapture: (id: Id, body: UpdateCaptureRequest) =>
    request<MutationResponse<Capture>>("PATCH", `/api/captures/${seg(id)}`, { body }),
  retryCapture: (id: Id) => request<{ capture: Capture }>("POST", `/api/captures/${seg(id)}/retry`),

  createCaptureText: async (text: string, onProgress?: (progress: number) => void) => {
    const form = new FormData();
    form.append("kind", "text");
    form.append("text", text);
    onProgress?.(0);
    const result = await uploadCapture(form, onProgress);
    onProgress?.(100);
    return result;
  },
  createCaptureFile: (
    file: File,
    kind: "voice" | "file",
    duration_s: number | null = null,
    onProgress?: (progress: number) => void,
  ) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);
    if (duration_s !== null) form.append("duration_s", String(duration_s));
    return uploadCapture(form, onProgress);
  },
};

/** Where a capture's audio streams from (after the session check). */
export function captureAudioUrl(captureId: Id): string {
  return `/api/captures/${seg(captureId)}/audio`;
}

/** Where one attachment of an email capture downloads from (after the session check). */
export function captureAttachmentUrl(captureId: Id, attachmentId: Id): string {
  return `/api/captures/${seg(captureId)}/attachments/${seg(attachmentId)}`;
}

/** The conflicts of a 409 revert_conflict error, or null for any other error. */
export function revertConflicts(err: unknown): RevertConflictView[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "revert_conflict") return null;
  const details = err.details;
  if (typeof details !== "object" || details === null || !("conflicts" in details)) return [];
  const conflicts = (details as { conflicts: unknown }).conflicts;
  return Array.isArray(conflicts) ? (conflicts as RevertConflictView[]) : [];
}

/** A message to show for any error thrown by the client or by the app code. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}
