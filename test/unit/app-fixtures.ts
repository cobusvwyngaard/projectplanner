// Small builders for the app's unit tests. Names and texts are made up.

import type { BootstrapResponse, ChangesResponse } from "../../src/shared/api";
import type { Capture, Label, Link, NoteView, PlannerEvent, TaskView, User } from "../../src/shared/types";

export const T0 = "2026-10-14T06:00:00.000Z";

export const ME: User = { id: "U1", email: null, display_name: "Cobus", initials: "CW", created_at: T0 };
export const OTHER: User = { id: "U2", email: null, display_name: "Anna", initials: "AN", created_at: T0 };

export function note(over: Partial<NoteView> & { id: string }): NoteView {
  return {
    title: `Note ${over.id}`,
    body: "",
    label_id: null,
    x: 0,
    y: 0,
    w: 240,
    h: 160,
    created_at: T0,
    updated_at: T0,
    archived_at: null,
    prov: null,
    ...over,
  };
}

export function task(over: Partial<TaskView> & { id: string }): TaskView {
  return {
    title: `Task ${over.id}`,
    detail: "",
    label_id: null,
    assignee_id: null,
    due_date: null,
    status: "open",
    done_at: null,
    done_by_user_id: null,
    x: null,
    y: null,
    created_at: T0,
    updated_at: T0,
    archived_at: null,
    prov: null,
    ...over,
  };
}

export function label(over: Partial<Label> & { id: string }): Label {
  return { name: `Label ${over.id}`, colour_hex: "#fde68a", sort_order: 0, archived_at: null, created_at: T0, ...over };
}

export function link(over: Partial<Link> & { id: string }): Link {
  return { a_type: "note", a_id: "N1", b_type: "task", b_id: "T1", created_at: T0, archived_at: null, ...over };
}

export function capture(over: Partial<Capture> & { id: string }): Capture {
  return {
    kind: "text",
    author_user_id: ME.id,
    r2_key: null,
    mime: null,
    duration_s: null,
    text: `Capture ${over.id}`,
    transcript_status: "n/a",
    transcript_error: null,
    transcribe_attempts: 0,
    transcribe_next_at: null,
    inbox_status: "new",
    claimed_by_run_id: null,
    claimed_at: null,
    processed_by_run_id: null,
    processed_at: null,
    processing_note: null,
    created_at: T0,
    ...over,
  };
}

export function event(over: Partial<PlannerEvent> & { seq: number }): PlannerEvent {
  return {
    id: `E${over.seq}`,
    ts: T0,
    actor_kind: "human",
    actor_user_id: ME.id,
    run_id: null,
    entity_type: "note",
    entity_id: "N1",
    action: "update",
    before: null,
    after: null,
    source_capture_ids: null,
    reverts_event_id: null,
    ...over,
  };
}

export function bootstrap(over: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    me: ME,
    users: [ME, OTHER],
    labels: [],
    notes: [],
    tasks: [],
    links: [],
    settings: { stt_keyterms: [], stt_keyterms_enabled: false, default_label_id: null },
    cursor: "E10",
    today: "2026-10-14",
    ...over,
  };
}

export function changes(over: Partial<ChangesResponse> = {}): ChangesResponse {
  return {
    events: [],
    notes: [],
    tasks: [],
    links: [],
    labels: [],
    users: [],
    settings: null,
    captures: [],
    cursor: "E10",
    more: false,
    reset: false,
    ...over,
  };
}
