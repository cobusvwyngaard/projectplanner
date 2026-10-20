// Events in plain words for the item history and the Activity view: who did
// what to which item, and a field-level diff with names instead of ids.

import { actorLabel, eventActor, userName, type UserLookup } from "../../shared/actors";
import { formatDate, excerpt } from "../../shared/format";
import type { EntityType, EventAction, Id, Label, PlannerEvent, SettingKey } from "../../shared/types";

export interface FieldChange {
  /** Field name as stored, or "position" / "size" for combined coordinates */
  field: string;
  /** The field in words */
  label: string;
  /** The old value in words; null for a creation (only the new value is shown) */
  before: string | null;
  after: string;
  /** Label colours to show next to the values */
  beforeColour?: string | null;
  afterColour?: string | null;
}

export interface EventView {
  actor: string;
  /** What happened, e.g. "ticked off", "moved", "changed" */
  verb: string;
  /** The kind of item with its article ("the note"); empty when the title says it all */
  noun: string;
  /** The item's title, if known */
  title: string | null;
  /** Words after the title, e.g. "on the board" */
  suffix: string;
  changes: FieldChange[];
  revertible: boolean;
}

export interface DescribeContext {
  users: UserLookup;
  labels: ReadonlyMap<Id, Label>;
  /** Display titles keyed "type:id" (from the API, plus any the app knows) */
  titles: Readonly<Record<string, string>>;
}

const NOUNS: Record<EntityType, string> = {
  note: "the note",
  task: "the task",
  link: "",
  label: "the label",
  capture: "the capture",
  user: "the person",
  setting: "the setting",
  user_email: "the email address",
  attachment: "the attachment",
  session: "a browser",
  claude_connection: "a Claude connection",
};

const SETTING_NAMES: Record<SettingKey, string> = {
  stt_keyterms: "Transcription keyterms",
  stt_keyterms_enabled: "Keyterm prompting",
  default_label_id: "Default label",
};

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  body: "Text",
  detail: "Details",
  label_id: "Label",
  assignee_id: "Assigned to",
  due_date: "Due date",
  status: "Status",
  position: "Position",
  size: "Size",
  name: "Name",
  colour_hex: "Colour",
  sort_order: "Order",
  display_name: "Name",
  initials: "Initials",
  text: "Transcript",
  inbox_status: "Inbox status",
  processing_note: "Processing note",
  archived_at: "Archived",
};

/** Fields that are bookkeeping, shown through the verb, or never interesting in a diff. */
const HIDDEN_FIELDS = new Set([
  "id", "created_at", "updated_at", "done_at", "done_by_user_id",
  "a_type", "a_id", "b_type", "b_id", "kind", "author_user_id", "email",
  "r2_key", "mime", "duration_s", "transcript_json", "transcript_status", "transcript_error",
  "transcribe_attempts", "transcribe_next_at", "claimed_by_run_id", "claimed_at",
  "processed_by_run_id", "processed_at", "key",
]);

/** Fields shown when an item is created (others are defaults or positions). */
const CREATE_FIELDS = new Set([
  "title", "body", "detail", "label_id", "assignee_id", "due_date", "name", "colour_hex",
  "display_name", "initials", "text", "value_json",
]);

const REVERTIBLE_ACTIONS: ReadonlySet<EventAction> = new Set([
  "create", "update", "archive", "unarchive", "complete", "reopen", "link", "unlink", "revert",
]);

/** Kinds of record whose creation cannot be undone (they cannot be archived). */
const UNARCHIVABLE: ReadonlySet<EntityType> = new Set(["capture", "user", "setting", "session"]);

export function fieldLabel(field: string): string {
  if (field === "x" || field === "y") return FIELD_LABELS.position ?? field;
  if (field === "w" || field === "h") return FIELD_LABELS.size ?? field;
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function settingName(key: string): string {
  return key in SETTING_NAMES ? SETTING_NAMES[key as SettingKey] : key;
}

/** Whether the app offers a Revert button for this event. */
export function isRevertible(event: PlannerEvent): boolean {
  if (event.entity_type === "session" || !REVERTIBLE_ACTIONS.has(event.action)) return false;
  return !(event.before === null && UNARCHIVABLE.has(event.entity_type));
}

function textValue(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "(empty)";
  return excerpt(value, 140);
}

function settingValue(key: Id, json: unknown, ctx: DescribeContext): string {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      return json;
    }
  }
  switch (key) {
    case "stt_keyterms":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "None";
    case "stt_keyterms_enabled":
      return value === true ? "On" : "Off";
    case "default_label_id":
      return typeof value === "string" ? (ctx.labels.get(value)?.name ?? "Unknown label") : "None";
    default:
      return JSON.stringify(value);
  }
}

/** One value of a field in words. */
export function formatValue(field: string, value: unknown, ctx: DescribeContext): string {
  switch (field) {
    case "label_id":
      return typeof value === "string" ? (ctx.labels.get(value)?.name ?? "Unknown label") : "No label";
    case "assignee_id":
      return typeof value === "string" ? userName(value, ctx.users) : "Nobody";
    case "due_date":
      return typeof value === "string" ? formatDate(value) : "No date";
    case "status":
      return value === "done" ? "Done" : "Open";
    case "archived_at":
      return value === null || value === undefined ? "No" : "Yes";
    case "inbox_status":
      return typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1) : "—";
    case "sort_order":
      return typeof value === "number" ? String(value + 1) : "—";
    case "title":
    case "body":
    case "detail":
    case "text":
    case "processing_note":
    case "name":
    case "display_name":
      return textValue(value);
    default:
      if (value === null || value === undefined) return "—";
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function colourOf(field: string, value: unknown, ctx: DescribeContext): string | null {
  if (field === "colour_hex" && typeof value === "string") return value;
  if (field === "label_id" && typeof value === "string") return ctx.labels.get(value)?.colour_hex ?? null;
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** "10, 20"; a single coordinate when only one changed; "Not on the board" for a task in the tray. */
function positionText(x: unknown, y: unknown): string {
  if (x === null || y === null) return "Not on the board";
  const px = num(x);
  const py = num(y);
  if (px !== null && py !== null) return `${Math.round(px)}, ${Math.round(py)}`;
  if (px !== null) return `x ${Math.round(px)}`;
  return py !== null ? `y ${Math.round(py)}` : "—";
}

/** "240 × 160", or one side when only one changed. */
function sizeText(w: unknown, h: unknown): string {
  const pw = num(w);
  const ph = num(h);
  if (pw !== null && ph !== null) return `${Math.round(pw)} × ${Math.round(ph)}`;
  if (pw !== null) return `${Math.round(pw)} wide`;
  return ph !== null ? `${Math.round(ph)} high` : "—";
}

function fieldChange(field: string, before: unknown, after: unknown, ctx: DescribeContext, created: boolean): FieldChange {
  const change: FieldChange = {
    field,
    label: fieldLabel(field),
    before: created ? null : formatValue(field, before, ctx),
    after: formatValue(field, after, ctx),
  };
  const beforeColour = created ? null : colourOf(field, before, ctx);
  const afterColour = colourOf(field, after, ctx);
  if (beforeColour !== null) change.beforeColour = beforeColour;
  if (afterColour !== null) change.afterColour = afterColour;
  return change;
}

/** The field-level diff of an event, in words. */
export function eventChanges(event: PlannerEvent, ctx: DescribeContext): FieldChange[] {
  const after = event.after ?? {};
  const before = event.before ?? {};
  const created = event.before === null;
  if (created && event.entity_type === "link") return [];

  if (event.entity_type === "setting") {
    if (!("value_json" in after)) return [];
    return [
      {
        field: "value_json",
        label: settingName(event.entity_id),
        before: created ? null : settingValue(event.entity_id, before.value_json, ctx),
        after: settingValue(event.entity_id, after.value_json, ctx),
      },
    ];
  }

  const changes: FieldChange[] = [];
  const fields = Object.keys(after);
  const has = (f: string) => fields.includes(f);
  if (!created && (has("x") || has("y"))) {
    changes.push({
      field: "position",
      label: fieldLabel("position"),
      before: positionText(before.x, before.y),
      after: positionText(has("x") ? after.x : before.x, has("y") ? after.y : before.y),
    });
  }
  if (!created && (has("w") || has("h"))) {
    changes.push({
      field: "size",
      label: fieldLabel("size"),
      before: sizeText(before.w, before.h),
      after: sizeText(has("w") ? after.w : before.w, has("h") ? after.h : before.h),
    });
  }
  // Archiving shows in the verb, except when a revert archives or restores.
  const showArchived = event.action === "revert" || event.action === "update";
  for (const field of fields) {
    if (HIDDEN_FIELDS.has(field) || ["x", "y", "w", "h"].includes(field)) continue;
    if (field === "archived_at" && !showArchived) continue;
    if (field === "status" && (event.action === "complete" || event.action === "reopen")) continue;
    if (created) {
      if (!CREATE_FIELDS.has(field)) continue;
      const value = after[field];
      if (value === null || value === "" || value === undefined) continue;
    }
    changes.push(fieldChange(field, before[field], after[field], ctx, created));
  }
  return changes;
}

interface Verb {
  verb: string;
  suffix: string;
}

function updateVerb(event: PlannerEvent): Verb {
  const fields = Object.keys(event.after ?? {});
  const before = event.before ?? {};
  const after = event.after ?? {};
  if (fields.length > 0 && fields.every((f) => f === "x" || f === "y")) {
    if (before.x === null && after.x !== null) return { verb: "placed", suffix: "on the board" };
    if (after.x === null) return { verb: "took", suffix: "off the board" };
    return { verb: "moved", suffix: "" };
  }
  if (fields.length > 0 && fields.every((f) => ["x", "y", "w", "h"].includes(f))) return { verb: "resized", suffix: "" };
  return { verb: "changed", suffix: "" };
}

const ACTION_VERBS: Record<Exclude<EventAction, "create" | "update">, string> = {
  archive: "archived",
  unarchive: "unarchived",
  complete: "ticked off",
  reopen: "reopened",
  link: "linked",
  unlink: "unlinked",
  revert: "reverted a change to",
  login: "signed in",
  session_revoke: "signed out",
};

function verbFor(event: PlannerEvent): Verb {
  switch (event.action) {
    case "create":
      if (event.entity_type === "link") return { verb: "linked", suffix: "" };
      return { verb: event.entity_type === "capture" ? "captured" : "created", suffix: "" };
    case "update":
      return updateVerb(event);
    case "session_revoke": {
      // A disconnection names the client it belonged to, after the noun.
      if (event.entity_type !== "claude_connection") return { verb: ACTION_VERBS.session_revoke, suffix: "" };
      const name = event.before?.client_name;
      return { verb: "disconnected", suffix: typeof name === "string" && name !== "" ? `(${name})` : "" };
    }
    default:
      return { verb: ACTION_VERBS[event.action], suffix: "" };
  }
}

/** The display title of an event's item, if known. */
export function eventTitle(event: PlannerEvent, titles: Readonly<Record<string, string>>): string | null {
  if (event.entity_type === "setting") return settingName(event.entity_id);
  const title = titles[`${event.entity_type}:${event.entity_id}`];
  if (title === undefined) return null;
  return event.entity_type === "link" ? title.replace(/^Link: /, "") : title;
}

export function describeEvent(event: PlannerEvent, ctx: DescribeContext): EventView {
  if (event.entity_type === "user_email") return describeUserEmail(event, ctx);
  if (event.entity_type === "attachment") return describeAttachment(event, ctx);
  const { verb, suffix } = verbFor(event);
  const session = event.entity_type === "session";
  return {
    actor: actorLabel(eventActor(event), ctx.users),
    verb,
    noun: session && event.action === "login" ? "" : NOUNS[event.entity_type],
    title: session ? null : eventTitle(event, ctx.titles),
    suffix,
    changes: eventChanges(event, ctx),
    revertible: isRevertible(event),
  };
}

/**
 * "Cobus added an email address for Anna (anna@example.com)"; an archive is
 * the same sentence with "removed" (SPEC 11.2). The address and the person
 * both come from the event, so the sentence names them without a lookup.
 */
function describeUserEmail(event: PlannerEvent, ctx: DescribeContext): EventView {
  const row = event.after ?? event.before ?? {};
  const address = typeof row.address === "string" ? row.address : null;
  const userId = typeof row.user_id === "string" ? row.user_id : null;
  const known = userId !== null && ("get" in ctx.users ? ctx.users.has(userId) : ctx.users.some((u) => u.id === userId));
  const who = known && userId !== null ? userName(userId, ctx.users) : null;
  const added = event.action !== "archive";
  return {
    actor: actorLabel(eventActor(event), ctx.users),
    verb: added ? "added" : "removed",
    noun: `an email address${who === null ? "" : ` for ${who}`}${address === null ? "" : ` (${address})`}`,
    title: null,
    suffix: "",
    changes: [],
    // An added address can be removed again; a removal is final.
    revertible: added && isRevertible(event),
  };
}

/**
 * "Planner listed an attachment (notes.pdf) on an email": the email's title,
 * when the screen knows it, comes before "on an email". An attachment event
 * cannot be reverted (the row has nothing to archive).
 */
function describeAttachment(event: PlannerEvent, ctx: DescribeContext): EventView {
  const captureId = typeof event.after?.capture_id === "string" ? event.after.capture_id : event.entity_id;
  const filename = event.after?.filename;
  const name = typeof filename === "string" && filename !== "" ? filename : "Attachment";
  return {
    actor: actorLabel(eventActor(event), ctx.users),
    verb: "listed",
    noun: `an attachment (${name})`,
    title: ctx.titles[`capture:${captureId}`] ?? null,
    suffix: "on an email",
    changes: [],
    revertible: false,
  };
}
