// Small helpers shared by the /api routers: reading input, naming the actor
// and shaping mutation results.

import type { Context } from "hono";
import { z } from "zod";
import type { MutationResponse, RevertResponse } from "../../shared/api";
import type { NoteView, TaskView } from "../../shared/types";
import { provenanceFor } from "../board/provenance";
import type { RowKind, RowTypes } from "../board/queries";
import type { AppBindings } from "../env";
import { ValidationError } from "../lib/errors";
import { parse } from "../lib/http";
import { humanActor, type Actor } from "../mutate/actor";
import type { MutationResult, Row, Value } from "../mutate/index";
import type { RevertOutcome } from "../mutate/revert";

/** The signed-in person, as the actor of a change. */
export function actorOf(c: Context<AppBindings>): Actor {
  return humanActor(c.get("user").id);
}

/** Validate the query string. Empty parameters count as absent. */
export function queryParams<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ""));
  return parse(schema, raw);
}

/** Read and validate a JSON body that may also be left out entirely (treated as {}). */
export async function optionalJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  if (text.trim() === "") return parse(schema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError("The request body must be JSON.");
  }
  return parse(schema, raw);
}

/** A validated request object as mutate() values, leaving out fields that were not given. */
export function toRow(values: Readonly<Record<string, Value | undefined>>): Row {
  const row: Row = {};
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined) row[field] = value;
  }
  return row;
}

/**
 * The row of a mutation result as its API type. mutate() returns every
 * column of the row exactly as stored (it reads the full row, or builds it
 * from the table defaults when creating), so the shape matches the schema.
 */
export function rowAs<K extends RowKind>(_kind: K, result: MutationResult): RowTypes[K] {
  return result.row as unknown as RowTypes[K];
}

export function mutationResponse<K extends RowKind>(kind: K, result: MutationResult): MutationResponse<RowTypes[K]> {
  return { row: rowAs(kind, result), event: result.event };
}

/** Body of POST /api/events/:id/revert and /api/runs/:id/revert. */
export const revertBody = z.strictObject({ confirm: z.boolean().optional() });

export function revertResponse(outcome: RevertOutcome): RevertResponse {
  return {
    reverted: outcome.reverted,
    events: outcome.results.flatMap((r) => (r.event === null ? [] : [r.event])),
  };
}

/** A note change with the note's provenance badges. */
export async function noteResponse(db: D1Database, result: MutationResult): Promise<MutationResponse<NoteView>> {
  const row = rowAs("note", result);
  const prov = await provenanceFor(db, "note", [row.id]);
  return { row: { ...row, prov: prov.get(row.id) ?? null }, event: result.event };
}

/** A task change with the task's provenance badges. */
export async function taskResponse(db: D1Database, result: MutationResult): Promise<MutationResponse<TaskView>> {
  const row = rowAs("task", result);
  const prov = await provenanceFor(db, "task", [row.id]);
  return { row: { ...row, prov: prov.get(row.id) ?? null }, event: result.event };
}
