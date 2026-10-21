// The app's initial load (/api/bootstrap) and its change feed (/api/changes,
// SPEC section 4.2). events.seq is the commit order; clients hold the id of
// the last event they saw and ask for everything committed after it.

import type { BootstrapResponse, ChangesResponse } from "../../shared/api";
import type { EntityType, Id, PlannerEvent, User } from "../../shared/types";
import { localToday } from "../lib/time";
import { EVENT_COLUMNS } from "../mutate/events";
import { readSettings } from "../settings";
import { noteViews, taskViews } from "./provenance";
import {
  activeLinks,
  listLabels,
  listUserEmails,
  listUsers,
  newestEvent,
  openNotes,
  openTasks,
  rowsByIds,
  selectEvents,
} from "./queries";

/** Most events one /api/changes response carries. */
export const CHANGES_PAGE_SIZE = 500;

/** Everything the app needs to draw the board. */
export async function loadBootstrap(db: D1Database, me: User, now: Date = new Date()): Promise<BootstrapResponse> {
  // Read the cursor first: anything committed while the rows are read is
  // newer than the cursor, so the change feed delivers it again.
  const newest = await newestEvent(db);
  const [users, userEmails, labels, notes, tasks, links, settings] = await Promise.all([
    listUsers(db),
    listUserEmails(db),
    listLabels(db),
    openNotes(db),
    openTasks(db),
    activeLinks(db),
    readSettings(db),
  ]);
  const [noteRows, taskRows] = await Promise.all([noteViews(db, notes), taskViews(db, tasks)]);
  return {
    me: users.find((u) => u.id === me.id) ?? me,
    users,
    user_emails: userEmails,
    labels,
    notes: noteRows,
    tasks: taskRows,
    links,
    settings,
    cursor: newest?.id ?? null,
    today: localToday(now),
  };
}

function emptyChanges(cursor: Id | null, reset: boolean): ChangesResponse {
  return {
    events: [],
    notes: [],
    tasks: [],
    links: [],
    labels: [],
    users: [],
    user_emails: [],
    attachments: [],
    settings: null,
    captures: [],
    cursor,
    more: false,
    reset,
  };
}

/**
 * Events committed after the event `since` (oldest first, at most
 * CHANGES_PAGE_SIZE) and the current rows they touched, archived ones
 * included. An unknown `since` asks the app to reload (reset); so does a
 * missing one once some events exist. Events committed while the page is read
 * are newer than the last one sent, so the next poll delivers them.
 */
export async function loadChanges(db: D1Database, since: Id | undefined): Promise<ChangesResponse> {
  if (since === undefined) return emptyChanges(null, (await newestEvent(db)) !== null);
  const cursor = await db.prepare(`SELECT seq FROM events WHERE id = ?`).bind(since).first<{ seq: number }>();
  if (!cursor) return emptyChanges(since, true);

  const page = await selectEvents(
    db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq > ? ORDER BY seq LIMIT ?`)
      .bind(cursor.seq, CHANGES_PAGE_SIZE + 1),
  );
  const more = page.length > CHANGES_PAGE_SIZE;
  const events = more ? page.slice(0, CHANGES_PAGE_SIZE) : page;
  if (events.length === 0) return emptyChanges(since, false);

  const touched = (type: EntityType) => idsOf(events, type);
  const [notes, tasks, links, labels, users, userEmails, captures, attachments, settings] = await Promise.all([
    rowsByIds(db, "note", touched("note")).then((rows) => noteViews(db, rows)),
    rowsByIds(db, "task", touched("task")).then((rows) => taskViews(db, rows)),
    rowsByIds(db, "link", touched("link")),
    rowsByIds(db, "label", touched("label")),
    rowsByIds(db, "user", touched("user")),
    rowsByIds(db, "user_email", touched("user_email")),
    rowsByIds(db, "capture", touched("capture")),
    rowsByIds(db, "attachment", touched("attachment")),
    touched("setting").length > 0 ? readSettings(db) : Promise.resolve(null),
  ]);
  return {
    events,
    notes,
    tasks,
    links,
    labels,
    users,
    user_emails: userEmails,
    attachments,
    settings,
    captures,
    cursor: events[events.length - 1]?.id ?? since,
    more,
    reset: false,
  };
}

function idsOf(events: readonly PlannerEvent[], type: EntityType): Id[] {
  return [...new Set(events.filter((e) => e.entity_type === type).map((e) => e.entity_id))];
}
