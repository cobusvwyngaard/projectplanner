// Reverting changes (SPEC section 5). A revert never rewrites history: it is a
// new change, made through mutate(), recorded with action 'revert' and the id
// of the event it reverts.

import type { PlannerEvent } from "../../shared/types";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import type { Actor } from "./actor";
import { ENTITIES, type MutableEntity } from "./entities";
import { EVENT_COLUMNS, parseEventRow, type EventRow } from "./events";
import { mutateMany, type Mutation, type MutationResult, type Row, type Value } from "./index";

const REVERTABLE_ACTIONS = new Set([
  "create", "update", "archive", "unarchive", "complete", "reopen", "link", "unlink", "revert",
]);

/** A later change that touched a field the revert would set back. */
export interface RevertConflict {
  event_id: string;
  field: string;
  later_event: PlannerEvent;
}

export interface RevertOutcome {
  results: MutationResult[];
  /** Number of events that changed something (others were already undone) */
  reverted: number;
}

/** Thrown when later changes touched the same fields and confirm was not given. */
export class RevertConflictError extends ConflictError {
  constructor(readonly conflicts: RevertConflict[]) {
    super("Later changes touched the same fields. Confirm to revert anyway.", { conflicts });
  }
}

export async function loadEvent(db: D1Database, eventId: string): Promise<PlannerEvent> {
  const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!row) throw new NotFoundError("No such change.");
  return parseEventRow(row);
}

/** The fields an event changed, and the values a revert sets them back to. */
export function revertPatch(event: PlannerEvent, now: string): Row {
  if (!REVERTABLE_ACTIONS.has(event.action) || !(event.entity_type in ENTITIES)) {
    throw new ValidationError("This kind of change cannot be reverted.");
  }
  const spec = ENTITIES[event.entity_type as MutableEntity];
  if (event.before === null) {
    // Undoing a creation archives the item; nothing is ever deleted.
    if (!spec.archive) throw new ValidationError("This kind of change cannot be reverted.");
    return { [spec.archive]: now };
  }
  const patch: Row = {};
  for (const [field, value] of Object.entries(event.before)) patch[field] = value as Value;
  return patch;
}

/**
 * Later events on the same entity that touched any field the revert would
 * set. For a creation every later change counts.
 */
export async function findConflicts(
  db: D1Database,
  events: readonly PlannerEvent[],
  ignore: ReadonlySet<string>,
): Promise<RevertConflict[]> {
  const conflicts: RevertConflict[] = [];
  for (const event of events) {
    const { results } = await db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE entity_type = ? AND entity_id = ? AND seq > ? ORDER BY seq`)
      .bind(event.entity_type, event.entity_id, event.seq)
      .all<EventRow>();
    const fields = event.before === null ? null : new Set(Object.keys(event.before));
    for (const later of results.map(parseEventRow)) {
      if (ignore.has(later.id)) continue;
      if (later.reverts_event_id !== null && ignore.has(later.reverts_event_id)) continue;
      const touched = Object.keys(later.after ?? {});
      const hit = fields === null ? touched[0] : touched.find((f) => fields.has(f));
      if (hit !== undefined) conflicts.push({ event_id: event.id, field: hit, later_event: later });
    }
  }
  return conflicts;
}

/** Revert one event. */
export async function revertEvent(
  db: D1Database,
  actor: Actor,
  eventId: string,
  options: { confirm?: boolean; now?: Date } = {},
): Promise<RevertOutcome> {
  const event = await loadEvent(db, eventId);
  return revertEvents(db, actor, [event], new Set([event.id]), options);
}

/** Revert every event of a Claude run, newest first, in one transaction. */
export async function revertRun(
  db: D1Database,
  actor: Actor,
  runId: string,
  options: { confirm?: boolean; now?: Date } = {},
): Promise<RevertOutcome> {
  const run = await db.prepare(`SELECT id FROM runs WHERE id = ?`).bind(runId).first();
  if (!run) throw new NotFoundError("No such run.");
  const { results } = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE run_id = ? ORDER BY seq DESC`)
    .bind(runId)
    .all<EventRow>();
  const events = results.map(parseEventRow);
  return revertEvents(db, actor, events, new Set(events.map((e) => e.id)), options);
}

async function revertEvents(
  db: D1Database,
  actor: Actor,
  newestFirst: readonly PlannerEvent[],
  ownIds: ReadonlySet<string>,
  options: { confirm?: boolean; now?: Date },
): Promise<RevertOutcome> {
  const now = options.now ?? new Date();
  const mutations: Mutation[] = newestFirst.map((event) => ({
    entity: event.entity_type as MutableEntity,
    action: "revert",
    id: event.entity_id,
    patch: revertPatch(event, now.toISOString()),
    revertsEventId: event.id,
  }));
  if (!options.confirm) {
    const conflicts = await findConflicts(db, newestFirst, ownIds);
    if (conflicts.length > 0) throw new RevertConflictError(conflicts);
  }
  const results = await mutateMany(db, actor, mutations, { now });
  return { results, reverted: results.filter((r) => r.event !== null).length };
}
