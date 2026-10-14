// /api/tasks: create, edit, assign, date, place, tick off, reopen, archive and
// unarchive tasks.

import { Hono } from "hono";
import { z } from "zod";
import { getRow } from "../board/queries";
import { checkAssigneeId, checkLabelId, fields } from "../board/validation";
import type { AppBindings } from "../env";
import { NotFoundError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { actorOf, taskResponse, toRow } from "./request";

const taskFields = {
  detail: fields.text.optional(),
  label_id: fields.labelId.optional(),
  assignee_id: fields.assigneeId.optional(),
  due_date: fields.dueDate.optional(),
  x: fields.coordinate.nullable().optional(),
  y: fields.coordinate.nullable().optional(),
};

type Position = { x?: number | null | undefined; y?: number | null | undefined };

/** x and y travel together: both numbers to place the task, both null for the tray. */
const placedTogether = (v: Position) => (v.x === undefined) === (v.y === undefined) && (v.x === null) === (v.y === null);
const PLACEMENT_RULE = {
  message: "Give x and y together: both numbers to place the task, or both null to put it in the tray.",
  path: ["x"],
};

const createTask = z.strictObject({ title: fields.taskTitle, ...taskFields }).refine(placedTogether, PLACEMENT_RULE);

const updateTask = z
  .strictObject({ title: fields.taskTitle.optional(), status: z.enum(["open", "done"]).optional(), ...taskFields })
  .refine(placedTogether, PLACEMENT_RULE);

export const tasksRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    const db = c.env.DB;
    const body = await jsonBody(c, createTask);
    await Promise.all([checkLabelId(db, body.label_id), checkAssigneeId(db, body.assignee_id)]);
    const result = await mutate(db, actorOf(c), { entity: "task", action: "create", values: toRow(body) });
    return c.json(await taskResponse(db, result), 201);
  })
  .patch("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const body = await jsonBody(c, updateTask);
    const task = await getRow(db, "task", id);
    if (!task) throw new NotFoundError(`No task with id ${id}.`);
    await Promise.all([checkLabelId(db, body.label_id, task.label_id), checkAssigneeId(db, body.assignee_id)]);
    // A status change is recorded by mutate() as 'complete' or 'reopen'.
    const result = await mutate(db, actorOf(c), { entity: "task", action: "update", id, patch: toRow(body) });
    return c.json(await taskResponse(db, result));
  })
  .post("/:id/complete", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "task", action: "complete", id: c.req.param("id") });
    return c.json(await taskResponse(db, result));
  })
  .post("/:id/reopen", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "task", action: "reopen", id: c.req.param("id") });
    return c.json(await taskResponse(db, result));
  })
  .post("/:id/archive", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "task", action: "archive", id: c.req.param("id") });
    return c.json(await taskResponse(db, result));
  })
  .post("/:id/unarchive", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "task", action: "unarchive", id: c.req.param("id") });
    return c.json(await taskResponse(db, result));
  });
