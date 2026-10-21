// Provenance badges (SPEC section 5): who created each note or task and who
// last changed it, taken from the first and last event of the item.

import type {
  ActorKind,
  ActorRef,
  FromOutside,
  Id,
  ItemType,
  Note,
  NoteView,
  Provenance,
  Task,
  TaskView,
  Timestamp,
} from "../../shared/types";
import { MAX_PARAMS, selectInChunks } from "./queries";

interface EdgeRow {
  entity_id: Id;
  seq: number;
  ts: Timestamp;
  actor_kind: ActorKind;
  actor_user_id: Id | null;
}

/**
 * The provenance of each item with at least one event, keyed by id.
 *
 * The inner query finds the first and last seq of each item with the
 * events_entity index (entity_type, entity_id, seq); the outer one fetches
 * just those events by primary key.
 */
export async function provenanceFor(db: D1Database, type: ItemType, ids: Iterable<Id>): Promise<Map<Id, Provenance>> {
  const rows = await selectInChunks<EdgeRow>(
    db,
    ids,
    (part, marks) =>
      db
        .prepare(
          `SELECT e.entity_id, e.seq, e.ts, e.actor_kind, e.actor_user_id
           FROM (SELECT entity_id, MIN(seq) AS first_seq, MAX(seq) AS last_seq
                 FROM events WHERE entity_type = ? AND entity_id IN (${marks})
                 GROUP BY entity_id) AS m
           JOIN events AS e ON e.seq IN (m.first_seq, m.last_seq)
           ORDER BY e.seq`,
        )
        .bind(type, ...part),
    MAX_PARAMS - 1,
  );

  const out = new Map<Id, Provenance>();
  for (const row of rows) {
    const actor: ActorRef = { kind: row.actor_kind, user_id: row.actor_user_id };
    const known = out.get(row.entity_id);
    // Rows arrive in seq order: the first one seen is the creation.
    if (known) {
      known.changed_by = actor;
      known.changed_at = row.ts;
    } else {
      out.set(row.entity_id, { created_by: actor, created_at: row.ts, changed_by: actor, changed_at: row.ts });
    }
  }
  return out;
}

/** Notes with their provenance badges. */
export async function noteViews(db: D1Database, notes: readonly Note[]): Promise<NoteView[]> {
  const prov = await provenanceFor(db, "note", notes.map((n) => n.id));
  return notes.map((n) => ({ ...n, prov: prov.get(n.id) ?? null }));
}

/** Tasks with their provenance badges and whether they came from an outside sender. */
export async function taskViews(db: D1Database, tasks: readonly Task[]): Promise<TaskView[]> {
  const ids = tasks.map((t) => t.id);
  const [prov, outside] = await Promise.all([provenanceFor(db, "task", ids), fromOutsideFor(db, ids)]);
  return tasks.map((t) => ({
    ...t,
    prov: prov.get(t.id) ?? null,
    from_outside: outside.get(t.id) ?? null,
  }));
}

interface OutsideRow {
  entity_id: Id;
  /** 0 = unregistered sender, 1 = unverified sender, 2 = every sender verified */
  rank: number;
}

/**
 * Why each task came from outside, keyed by task id. Only tasks with such a
 * source appear.
 *
 * One query follows every source capture of every task to its email
 * participants and ranks the From person: no planner person at all (0) beats
 * a planner person whose address failed verification (1); a verified sender
 * (2) is not outside. A capture with no readable From counts as unregistered,
 * because its sender maps to nobody.
 */
export async function fromOutsideFor(db: D1Database, taskIds: Iterable<Id>): Promise<Map<Id, FromOutside>> {
  const rows = await selectInChunks<OutsideRow>(db, taskIds, (part, marks) =>
    db
      .prepare(
        `SELECT e.entity_id,
                MIN(CASE
                      WHEN json_extract(f.value, '$.user_id') IS NULL THEN 0
                      WHEN c.email_sender_verified = 0 THEN 1
                      ELSE 2
                    END) AS rank
         FROM events AS e
         JOIN json_each(e.source_capture_ids) AS s
         JOIN captures AS c ON c.id = s.value AND c.kind = 'email'
         LEFT JOIN json_each(c.email_participants_json) AS f
           ON json_extract(f.value, '$.role') = 'from'
         WHERE e.entity_type = 'task' AND e.entity_id IN (${marks})
         GROUP BY e.entity_id`,
      )
      .bind(...part),
  );

  const out = new Map<Id, FromOutside>();
  for (const row of rows) {
    if (row.rank === 0) out.set(row.entity_id, "unregistered");
    else if (row.rank === 1) out.set(row.entity_id, "unverified");
  }
  return out;
}
