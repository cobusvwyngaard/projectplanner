// Helpers for Worker tests: a clean database and the two seeded users.

import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { PlannerEvent } from "../../src/shared/types";
import { EVENT_COLUMNS, parseEventRow, type EventRow } from "../../src/worker/mutate/events";

export const USER_1 = "00000000000000000000000001";
export const USER_2 = "00000000000000000000000002";

/** Wipe all storage and re-apply the migrations. */
export async function freshDb(): Promise<D1Database> {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
}

export async function allEvents(db: D1Database = env.DB): Promise<PlannerEvent[]> {
  const { results } = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY seq`).all<EventRow>();
  return results.map(parseEventRow);
}

export async function eventsFor(entityType: string, entityId: string, db: D1Database = env.DB): Promise<PlannerEvent[]> {
  const { results } = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY seq`)
    .bind(entityType, entityId)
    .all<EventRow>();
  return results.map(parseEventRow);
}

/** Insert an open Claude run directly (the MCP start_run tool is tested separately). */
export async function openRun(
  userId: string,
  options: { id?: string; startedAt?: string; finished?: boolean } = {},
  db: D1Database = env.DB,
): Promise<string> {
  const id = options.id ?? `01RUN${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(21, "0")}`.slice(0, 26);
  await db
    .prepare(`INSERT INTO runs (id, user_id, intent, started_at, finished_at) VALUES (?, ?, 'test run', ?, ?)`)
    .bind(id, userId, options.startedAt ?? new Date().toISOString(), options.finished ? new Date().toISOString() : null)
    .run();
  return id;
}
