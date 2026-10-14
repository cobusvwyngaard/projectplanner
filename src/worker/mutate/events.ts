import type { ActorKind, EntityType, EventAction, PlannerEvent } from "../../shared/types";
import type { Actor } from "./actor";

/** An event about to be inserted. */
export interface NewEvent {
  id: string;
  ts: string;
  actor: Actor;
  entityType: EntityType;
  entityId: string;
  action: EventAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  sourceCaptureIds: readonly string[] | null;
  revertsEventId: string | null;
}

/**
 * The only INSERT into events in the codebase. Callers put the returned
 * statement in the same db.batch() as the write it describes.
 */
export function eventStatement(db: D1Database, ev: NewEvent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, ts, actor_kind, actor_user_id, run_id, entity_type, entity_id, action,
         before_json, after_json, source_capture_ids, reverts_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ev.id,
      ev.ts,
      ev.actor.kind,
      ev.actor.userId,
      ev.actor.runId,
      ev.entityType,
      ev.entityId,
      ev.action,
      ev.before === null ? null : JSON.stringify(ev.before),
      ev.after === null ? null : JSON.stringify(ev.after),
      ev.sourceCaptureIds === null || ev.sourceCaptureIds.length === 0
        ? null
        : JSON.stringify(ev.sourceCaptureIds),
      ev.revertsEventId,
    );
}

export function toPlannerEvent(ev: NewEvent, seq: number): PlannerEvent {
  return {
    seq,
    id: ev.id,
    ts: ev.ts,
    actor_kind: ev.actor.kind,
    actor_user_id: ev.actor.userId,
    run_id: ev.actor.runId,
    entity_type: ev.entityType,
    entity_id: ev.entityId,
    action: ev.action,
    before: ev.before,
    after: ev.after,
    source_capture_ids:
      ev.sourceCaptureIds === null || ev.sourceCaptureIds.length === 0 ? null : [...ev.sourceCaptureIds],
    reverts_event_id: ev.revertsEventId,
  };
}

/** Raw events row as D1 returns it. */
export interface EventRow {
  seq: number;
  id: string;
  ts: string;
  actor_kind: ActorKind;
  actor_user_id: string | null;
  run_id: string | null;
  entity_type: EntityType;
  entity_id: string;
  action: EventAction;
  before_json: string | null;
  after_json: string | null;
  source_capture_ids: string | null;
  reverts_event_id: string | null;
}

export const EVENT_COLUMNS =
  "seq, id, ts, actor_kind, actor_user_id, run_id, entity_type, entity_id, action, before_json, after_json, source_capture_ids, reverts_event_id";

export function parseEventRow(row: EventRow): PlannerEvent {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    actor_kind: row.actor_kind,
    actor_user_id: row.actor_user_id,
    run_id: row.run_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as Record<string, unknown>),
    after: row.after_json === null ? null : (JSON.parse(row.after_json) as Record<string, unknown>),
    source_capture_ids:
      row.source_capture_ids === null ? null : (JSON.parse(row.source_capture_ids) as string[]),
    reverts_event_id: row.reverts_event_id,
  };
}
