// The Activity view (a filtered, global event feed) and the item history
// panel (SPEC section 5).

import type { EventsResponse, HistoryResponse } from "../../shared/api";
import type { ActorKind, EntityType, Id, LocalDate, PlannerEvent, Timestamp } from "../../shared/types";
import { NotFoundError } from "../lib/errors";
import { HOUR_MS, addDays, addMs, iso } from "../lib/time";
import { EVENT_COLUMNS } from "../mutate/events";
import { eventRunIds, getRow, rowsByIds, selectEvents, sourceCaptureIds } from "./queries";
import { eventRefs, titlesFor } from "./titles";

/** Africa/Johannesburg is UTC+2 all year (no daylight saving). */
const JOHANNESBURG_OFFSET_MS = 2 * HOUR_MS;

/** The UTC instant at which a local date starts in Africa/Johannesburg. */
export function localDayStart(date: LocalDate): Timestamp {
  return iso(addMs(new Date(`${date}T00:00:00.000Z`), -JOHANNESBURG_OFFSET_MS));
}

export interface EventFilters {
  actor?: ActorKind | undefined;
  user_id?: Id | undefined;
  run_id?: Id | undefined;
  /** First local date, inclusive */
  from?: LocalDate | undefined;
  /** Last local date, inclusive */
  to?: LocalDate | undefined;
  entity_type?: EntityType | undefined;
  entity_id?: Id | undefined;
  /** Only events with a smaller seq (paging) */
  before?: number | undefined;
  limit: number;
}

/** Events matching the filters, newest first, with the runs and titles they refer to. */
export async function listEvents(db: D1Database, filters: EventFilters): Promise<EventsResponse> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (condition: string, value: string | number) => {
    where.push(condition);
    params.push(value);
  };
  if (filters.actor !== undefined) add("actor_kind = ?", filters.actor);
  if (filters.user_id !== undefined) add("actor_user_id = ?", filters.user_id);
  if (filters.run_id !== undefined) add("run_id = ?", filters.run_id);
  if (filters.from !== undefined) add("ts >= ?", localDayStart(filters.from));
  if (filters.to !== undefined) add("ts < ?", localDayStart(addDays(filters.to, 1)));
  if (filters.entity_type !== undefined) add("entity_type = ?", filters.entity_type);
  if (filters.entity_id !== undefined) add("entity_id = ?", filters.entity_id);
  if (filters.before !== undefined) add("seq < ?", filters.before);

  const page = await selectEvents(
    db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY seq DESC LIMIT ?`,
      )
      .bind(...params, filters.limit + 1),
  );
  const more = page.length > filters.limit;
  const events = more ? page.slice(0, filters.limit) : page;
  const [runs, titles] = await Promise.all([
    rowsByIds(db, "run", eventRunIds(events)),
    titlesFor(db, eventRefs(events)),
  ]);
  return { events, runs, titles, next: more ? (events[events.length - 1]?.seq ?? null) : null };
}

/** Kinds of item that have a history panel. */
export const HISTORY_TYPES = ["note", "task", "label", "capture"] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

/**
 * An item's events, oldest first. For notes and tasks this includes the
 * events of every link (current or removed) that involves the item.
 */
export async function itemHistory(db: D1Database, type: HistoryType, id: Id): Promise<HistoryResponse> {
  if (!(await getRow(db, type, id))) throw new NotFoundError(`No ${type} with id ${id}.`);
  const own = `SELECT ${EVENT_COLUMNS} FROM events WHERE entity_type = ? AND entity_id = ?`;
  const statement =
    type === "note" || type === "task"
      ? db
          .prepare(
            `${own}
             UNION ALL
             SELECT ${EVENT_COLUMNS} FROM events
             WHERE entity_type = 'link' AND entity_id IN (
               SELECT id FROM links WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?))
             ORDER BY seq`,
          )
          .bind(type, id, type, id, type, id)
      : db.prepare(`${own} ORDER BY seq`).bind(type, id);
  const events: PlannerEvent[] = await selectEvents(statement);
  const [runs, captures, titles] = await Promise.all([
    rowsByIds(db, "run", eventRunIds(events)),
    rowsByIds(db, "capture", sourceCaptureIds(events)),
    titlesFor(db, [{ type, id }, ...eventRefs(events)]),
  ]);
  return { events, runs, captures, titles };
}
