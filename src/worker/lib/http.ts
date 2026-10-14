import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ApiErrorBody } from "../../shared/api";
import { AppError, ValidationError } from "./errors";

/** JSON error body for an AppError; anything else becomes a generic 500. */
export function errorBody(err: unknown): { status: ContentfulStatusCode; body: ApiErrorBody } {
  if (err instanceof AppError) {
    const error: ApiErrorBody["error"] = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { status: err.status as ContentfulStatusCode, body: { error } };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
  };
}

/** Hono onError handler for JSON routes. Logs only the error name and message. */
export function jsonError(err: unknown, c: Context): Response {
  const { status, body } = errorBody(err);
  if (status >= 500) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`${c.req.method} ${new URL(c.req.url).pathname} failed: ${e.name}: ${e.message}`);
  }
  return c.json(body, status);
}

/** Parse with a zod schema or throw a ValidationError listing the problems. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    throw new ValidationError(first ? `${first.path || "request"}: ${first.message}` : "Invalid request.", { issues });
  }
  return result.data;
}

/** Read and validate a JSON body. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError("The request body must be JSON.");
  }
  return parse(schema, raw);
}
