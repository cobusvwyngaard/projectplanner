// /api/events (the Activity view), /api/events/:id/revert and
// /api/history/:type/:id (the item history panel).

import { Hono } from "hono";
import { z } from "zod";
import type { EntityType } from "../../shared/types";
import { HISTORY_TYPES, itemHistory, listEvents } from "../board/activity";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { parse } from "../lib/http";
import { revertEvent } from "../mutate/revert";
import { actorOf, optionalJsonBody, queryParams, revertBody, revertResponse } from "./request";

const ENTITY_TYPES = [
  "note", "task", "link", "label", "capture", "user", "setting", "session",
] as const satisfies readonly EntityType[];

const eventsQuery = z
  .strictObject({
    actor: z.enum(["human", "claude", "system"], "actor must be human, claude or system.").optional(),
    user_id: fields.id.optional(),
    run_id: fields.id.optional(),
    from: fields.localDate.optional(),
    to: fields.localDate.optional(),
    entity_type: z.enum(ENTITY_TYPES, "That is not a kind of item the planner records.").optional(),
    entity_id: fields.id.optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "The start date must be on or before the end date.",
    path: ["from"],
  });

export const eventsRouter = new Hono<AppBindings>()
  .get("/", async (c) => c.json(await listEvents(c.env.DB, queryParams(c, eventsQuery))))
  .post("/:id/revert", async (c) => {
    const { confirm } = await optionalJsonBody(c, revertBody);
    const outcome = await revertEvent(c.env.DB, actorOf(c), c.req.param("id"), { confirm: confirm === true });
    return c.json(revertResponse(outcome));
  });

const historyType = z.enum(HISTORY_TYPES, "History is kept for notes, tasks, labels and captures.");

export const historyRouter = new Hono<AppBindings>().get("/:type/:id", async (c) => {
  const type = parse(historyType, c.req.param("type"));
  return c.json(await itemHistory(c.env.DB, type, c.req.param("id")));
});
