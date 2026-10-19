// Display titles for the entities events refer to, keyed "type:id", so the
// Activity view and item history can name things without extra requests.

import type { Capture, EntityType, Id, Link, Note, PlannerEvent } from "../../shared/types";
import { rowsByIds } from "./queries";

export interface EntityRef {
  type: EntityType;
  id: Id;
}

/** Captures are named by the start of their text, at most this many characters. */
export const EXCERPT_LENGTH = 60;

export function titleKey(type: EntityType, id: Id): string {
  return `${type}:${id}`;
}

/** Text squeezed onto one line and cut to `max` characters (with an ellipsis). */
export function excerpt(text: string, max: number = EXCERPT_LENGTH): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export function noteTitle(note: Pick<Note, "title" | "body">): string {
  return note.title.trim() || excerpt(note.body) || "Untitled note";
}

const CAPTURE_KIND: Record<Capture["kind"], string> = {
  voice: "Voice capture",
  text: "Text capture",
  file: "File capture",
  email: "Email",
};

export function captureTitle(capture: Pick<Capture, "kind" | "text">): string {
  return excerpt(capture.text ?? "") || CAPTURE_KIND[capture.kind];
}

/** The entities events refer to. */
export function eventRefs(events: readonly PlannerEvent[]): EntityRef[] {
  return events.map((e) => ({ type: e.entity_type, id: e.entity_id }));
}

/**
 * Titles for the given entities. A link is "Link: A ↔ B", and the titles of
 * its two items are included as well. Entities that do not exist are left out.
 */
export async function titlesFor(db: D1Database, refs: Iterable<EntityRef>): Promise<Record<string, string>> {
  const ids = new Map<EntityType, Set<Id>>();
  const want = (type: EntityType, id: Id) => {
    const set = ids.get(type) ?? new Set<Id>();
    set.add(id);
    ids.set(type, set);
  };
  for (const ref of refs) want(ref.type, ref.id);

  const links = await rowsByIds(db, "link", ids.get("link") ?? []);
  for (const link of links) {
    want(link.a_type, link.a_id);
    want(link.b_type, link.b_id);
  }
  const [notes, tasks, labels, users, captures, userEmails, attachments] = await Promise.all([
    rowsByIds(db, "note", ids.get("note") ?? []),
    rowsByIds(db, "task", ids.get("task") ?? []),
    rowsByIds(db, "label", ids.get("label") ?? []),
    rowsByIds(db, "user", ids.get("user") ?? []),
    rowsByIds(db, "capture", ids.get("capture") ?? []),
    rowsByIds(db, "user_email", ids.get("user_email") ?? []),
    rowsByIds(db, "attachment", ids.get("attachment") ?? []),
  ]);

  const titles: Record<string, string> = {};
  for (const n of notes) titles[titleKey("note", n.id)] = noteTitle(n);
  for (const t of tasks) titles[titleKey("task", t.id)] = t.title;
  for (const l of labels) titles[titleKey("label", l.id)] = l.name;
  for (const u of users) titles[titleKey("user", u.id)] = u.display_name;
  for (const c of captures) titles[titleKey("capture", c.id)] = captureTitle(c);
  for (const e of userEmails) titles[titleKey("user_email", e.id)] = e.address;
  for (const a of attachments) titles[titleKey("attachment", a.id)] = a.filename || "Attachment";
  for (const link of links) titles[titleKey("link", link.id)] = linkTitle(link, titles);
  for (const id of ids.get("setting") ?? []) titles[titleKey("setting", id)] = id;
  for (const id of ids.get("session") ?? []) titles[titleKey("session", id)] = "Browser sign-in";
  return titles;
}

function linkTitle(link: Link, titles: Record<string, string>): string {
  const end = (type: Link["a_type"], id: Id) => titles[titleKey(type, id)] ?? `Missing ${type}`;
  return `Link: ${end(link.a_type, link.a_id)} ↔ ${end(link.b_type, link.b_id)}`;
}
