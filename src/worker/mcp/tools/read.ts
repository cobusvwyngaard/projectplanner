// Read tools for the Claude connector (SPEC section 7). Plain functions over
// ToolContext, so they are testable without MCP; agent.ts registers them.

import type { Capture, CaptureAttachment, EmailParticipant, FromOutside, User } from "../../../shared/types";
import { localToday } from "../../../shared/dates";
import { NotFoundError } from "../../lib/errors";
import { ENTITIES } from "../../mutate/entities";
import { attachmentsForCaptures, activeLabels, activeLinks, getRow, listUsers, openNotes, openTasks } from "../../board/queries";
import { fromOutsideFor } from "../../board/provenance";
import { itemHistory } from "../../board/activity";
import { captureReady, type ToolContext } from "../runs";

/** Board text Claude reads is cut to this many characters. */
export const BOARD_TEXT_LIMIT = 2000;
/** Capture text Claude reads is cut to this many characters. */
export const INBOX_TEXT_LIMIT = 10_000;
/** Board and history caps. */
export const MAX_BOARD_NOTES = 200;
export const MAX_BOARD_TASKS = 300;
export const MAX_HISTORY_EVENTS = 100;

function cut(text: string | null, n: number): string {
  if (text === null) return "";
  return text.length > n ? text.slice(0, n) : text;
}

/** Newest first by creation, then id (stable). */
function newestFirst<T extends { created_at: string; id: string }>(a: T, b: T): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export async function getOverview(ctx: ToolContext): Promise<{
  me: { id: string; display_name: string };
  users: { id: string; display_name: string; initials: string }[];
  labels: { id: string; name: string; colour_hex: string }[];
  counts: { open_notes: number; open_tasks: number; overdue_tasks: number; inbox_new: number };
  today: string;
}> {
  const { db, userId, now } = ctx;
  const me = await getRow(db, "user", userId);
  if (!me) throw new NotFoundError("No such user.");
  const users = await listUsers(db);
  const labels = await activeLabels(db);
  const today = localToday(now);
  const openNotesCount = await db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE archived_at IS NULL`).first<{ n: number }>();
  const openTasksCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL AND status = 'open'`)
    .first<{ n: number }>();
  const overdueCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL AND status = 'open' AND due_date IS NOT NULL AND due_date < ?`)
    .bind(today)
    .first<{ n: number }>();
  const inboxNew = await db.prepare(`SELECT COUNT(*) AS n FROM captures WHERE inbox_status = 'new'`).first<{ n: number }>();
  return {
    me: { id: me.id, display_name: me.display_name },
    users: users.map((u) => ({ id: u.id, display_name: u.display_name, initials: u.initials })),
    labels: labels.map((l) => ({ id: l.id, name: l.name, colour_hex: l.colour_hex })),
    counts: {
      open_notes: openNotesCount?.n ?? 0,
      open_tasks: openTasksCount?.n ?? 0,
      overdue_tasks: overdueCount?.n ?? 0,
      inbox_new: inboxNew?.n ?? 0,
    },
    today,
  };
}

/** One person of an email, as Claude sees them (SPEC 11.4). */
export interface InboxParticipant {
  address: string;
  name: string;
  role: "from" | "to" | "cc";
  /** The planner person this address belongs to, or null when it maps to nobody */
  user_id: string | null;
  /** That person's name from the users list, or null when there is no person */
  display_name: string | null;
}

/** One attachment of an email, listed even when its content was not stored. */
export interface InboxAttachment {
  name: string;
  mime: string;
  size_bytes: number;
  /** True when the content is stored; a too-large attachment is listed without it */
  stored: boolean;
}

export interface InboxItem {
  id: string;
  kind: string;
  /** True when the capture may be claimed: typed text or a finished transcript */
  ready: boolean;
  /** Null for an email capture whose sender was not verified (SPEC 11.2) */
  author: { id: string; display_name: string } | null;
  created_at: string;
  duration_s: number | null;
  text: string | null;
  text_truncated: boolean;
  /** Present for kind 'email' only (SPEC 11.4) */
  email?: {
    subject: string | null;
    sender_verified: boolean;
    from: InboxParticipant | null;
    participants: InboxParticipant[];
    attachments: InboxAttachment[];
  };
}

function isParticipant(value: unknown): value is EmailParticipant {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.address === "string" &&
    typeof row.name === "string" &&
    (row.role === "from" || row.role === "to" || row.role === "cc") &&
    (typeof row.user_id === "string" || row.user_id === null)
  );
}

/** The people stored on an email capture; anything unreadable counts as nobody. */
export function parseEmailParticipants(json: string | null): EmailParticipant[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isParticipant);
}

/**
 * One inbox item as Claude sees it. The single builder for capture listings,
 * so every tool that lists captures shows the same email fields (SPEC 11.4).
 */
export function inboxItem(
  capture: Capture,
  users: readonly User[],
  attachments: readonly CaptureAttachment[] = [],
): InboxItem {
  const raw = capture.text;
  const truncated = raw !== null && raw.length > INBOX_TEXT_LIMIT;
  const authorId = capture.author_user_id;
  const author = authorId === null ? undefined : users.find((u) => u.id === authorId);
  const item: InboxItem = {
    id: capture.id,
    kind: capture.kind,
    ready: captureReady(capture),
    // An email capture from an unverified sender has no author (SPEC 11.2):
    // its From address may be forged, so no id is made up for it.
    author: authorId !== null && author !== undefined ? { id: authorId, display_name: author.display_name } : null,
    created_at: capture.created_at,
    duration_s: capture.duration_s,
    text: raw === null ? null : truncated ? raw.slice(0, INBOX_TEXT_LIMIT) : raw,
    text_truncated: truncated,
  };
  if (capture.kind === "email") {
    const names = new Map(users.map((u) => [u.id, u.display_name]));
    const participants: InboxParticipant[] = parseEmailParticipants(capture.email_participants_json).map((p) => ({
      address: p.address,
      name: p.name,
      role: p.role,
      user_id: p.user_id,
      display_name: p.user_id === null ? null : (names.get(p.user_id) ?? null),
    }));
    item.email = {
      subject: capture.email_subject,
      sender_verified: capture.email_sender_verified === 1,
      from: participants.find((p) => p.role === "from") ?? null,
      participants,
      attachments: attachments.map((a) => ({
        name: a.filename,
        mime: a.mime,
        size_bytes: a.size_bytes,
        stored: a.r2_key !== null,
      })),
    };
  }
  return item;
}

export interface BoardFilters {
  label_id?: string | null;
  assignee_id?: string | null;
  unassigned?: boolean;
  status?: "open" | "done";
  due_from?: string;
  due_to?: string;
  include_done?: boolean;
}

export async function getBoard(
  ctx: ToolContext,
  input: BoardFilters,
): Promise<{
  notes: { id: string; title: string; body: string; label_id: string | null }[];
  tasks: {
    id: string;
    title: string;
    detail: string;
    label_id: string | null;
    assignee_id: string | null;
    due_date: string | null;
    status: string;
    from_outside: FromOutside | null;
  }[];
  links: {
    a: { type: string; id: string };
    b: { type: string; id: string };
    /** "related" for a plain connection, "depends" for a dependency between two tasks */
    kind: "related" | "depends";
    /** The end that must be done first; null for a plain connection */
    before: { type: string; id: string } | null;
  }[];
  truncated: boolean;
}> {
  const { db } = ctx;
  let notes = await openNotes(db);
  if (input.label_id !== undefined && input.label_id !== null) {
    notes = notes.filter((n) => n.label_id === input.label_id);
  }
  notes.sort(newestFirst);
  const notesTruncated = notes.length > MAX_BOARD_NOTES;
  notes = notes.slice(0, MAX_BOARD_NOTES);

  let tasks = await openTasks(db);
  if (input.status === "open") tasks = tasks.filter((t) => t.status === "open");
  else if (input.status === "done") tasks = tasks.filter((t) => t.status === "done");
  else if (!input.include_done) tasks = tasks.filter((t) => t.status === "open");
  if (input.label_id !== undefined && input.label_id !== null) {
    tasks = tasks.filter((t) => t.label_id === input.label_id);
  }
  if (input.assignee_id !== undefined && input.assignee_id !== null) {
    tasks = tasks.filter((t) => t.assignee_id === input.assignee_id);
  }
  if (input.unassigned) tasks = tasks.filter((t) => t.assignee_id === null);
  if (input.due_from !== undefined) tasks = tasks.filter((t) => t.due_date !== null && t.due_date >= input.due_from!);
  if (input.due_to !== undefined) tasks = tasks.filter((t) => t.due_date !== null && t.due_date <= input.due_to!);
  tasks.sort(newestFirst);
  const tasksTruncated = tasks.length > MAX_BOARD_TASKS;
  tasks = tasks.slice(0, MAX_BOARD_TASKS);
  const outside = await fromOutsideFor(db, tasks.map((t) => t.id));

  const noteIds = new Set(notes.map((n) => n.id));
  const taskIds = new Set(tasks.map((t) => t.id));
  const links = (await activeLinks(db))
    .filter((l) => {
      const aOk = (l.a_type === "note" && noteIds.has(l.a_id)) || (l.a_type === "task" && taskIds.has(l.a_id));
      const bOk = (l.b_type === "note" && noteIds.has(l.b_id)) || (l.b_type === "task" && taskIds.has(l.b_id));
      return aOk && bOk;
    })
    .map((l) => {
      const a = { type: l.a_type, id: l.a_id };
      const b = { type: l.b_type, id: l.b_id };
      // A dependency says which end comes first; a plain connection has none.
      const kind: "related" | "depends" = l.direction === "none" ? "related" : "depends";
      const before = l.direction === "a_to_b" ? a : l.direction === "b_to_a" ? b : null;
      return { a, b, kind, before };
    });

  return {
    notes: notes.map((n) => ({ id: n.id, title: n.title, body: cut(n.body, BOARD_TEXT_LIMIT), label_id: n.label_id })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      detail: cut(t.detail, BOARD_TEXT_LIMIT),
      label_id: t.label_id,
      assignee_id: t.assignee_id,
      due_date: t.due_date,
      status: t.status,
      from_outside: outside.get(t.id) ?? null,
    })),
    links,
    truncated: notesTruncated || tasksTruncated,
  };
}

export async function getInbox(
  ctx: ToolContext,
  input: { limit?: number },
): Promise<{ items: InboxItem[]; not_ready: number }> {
  const { db } = ctx;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const users = await listUsers(db);
  const { results } = await db
    .prepare(`SELECT ${ENTITIES.capture.columns.join(", ")} FROM captures WHERE inbox_status = 'new' ORDER BY created_at ASC, id ASC`)
    .all<Capture>();
  const ready: Capture[] = [];
  let notReady = 0;
  for (const c of results) {
    if (captureReady(c)) ready.push(c);
    else notReady++;
  }
  const listed = ready.slice(0, limit);
  const emailIds = listed.filter((c) => c.kind === "email").map((c) => c.id);
  // One query for every listed email's attachments, never one per capture.
  const byCapture = new Map<string, CaptureAttachment[]>();
  for (const a of await attachmentsForCaptures(db, emailIds)) {
    const list = byCapture.get(a.capture_id);
    if (list === undefined) byCapture.set(a.capture_id, [a]);
    else list.push(a);
  }
  return { items: listed.map((c) => inboxItem(c, users, byCapture.get(c.id) ?? [])), not_ready: notReady };
}

export async function getHistory(
  ctx: ToolContext,
  input: { entity_type: "note" | "task"; entity_id: string },
): Promise<{
  events: {
    ts: string;
    actor: string;
    action: string;
    before: unknown;
    after: unknown;
    run_id: string | null;
    source_capture_ids: string[] | null;
  }[];
}> {
  const { db } = ctx;
  const users = await listUsers(db);
  const names = new Map(users.map((u) => [u.id, u.display_name]));
  const nameOf = (id: string | null): string => (id === null ? "Unknown" : (names.get(id) ?? id));
  const { events } = await itemHistory(db, input.entity_type, input.entity_id);
  return {
    events: events.slice(0, MAX_HISTORY_EVENTS).map((e) => ({
      ts: e.ts,
      actor:
        e.actor_kind === "human"
          ? nameOf(e.actor_user_id)
          : e.actor_kind === "claude"
            ? `Claude (via ${nameOf(e.actor_user_id)})`
            : "System",
      action: e.action,
      before: e.before,
      after: e.after,
      run_id: e.run_id,
      source_capture_ids: e.source_capture_ids,
    })),
  };
}
