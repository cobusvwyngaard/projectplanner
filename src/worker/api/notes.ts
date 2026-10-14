// /api/notes: create, edit, move, resize, archive and unarchive sticky notes.

import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_NOTE_SIZE, placeNote } from "../board/placement";
import { getRow } from "../board/queries";
import { checkLabelId, fields } from "../board/validation";
import type { AppBindings } from "../env";
import { NotFoundError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { actorOf, noteResponse, toRow } from "./request";

const noteFields = {
  title: fields.noteTitle.optional(),
  body: fields.text.optional(),
  label_id: fields.labelId.optional(),
  x: fields.coordinate.optional(),
  y: fields.coordinate.optional(),
  w: fields.noteWidth.optional(),
  h: fields.noteHeight.optional(),
};

const createNote = z
  .strictObject(noteFields)
  .refine((v) => (v.x === undefined) === (v.y === undefined), {
    message: "Give both x and y, or neither to let the board find a free spot.",
    path: ["x"],
  });

const updateNote = z.strictObject(noteFields);

export const notesRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    const db = c.env.DB;
    const body = await jsonBody(c, createNote);
    await checkLabelId(db, body.label_id);
    const size = { w: body.w ?? DEFAULT_NOTE_SIZE.w, h: body.h ?? DEFAULT_NOTE_SIZE.h };
    const spot = body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : await placeNote(db, size);
    const result = await mutate(db, actorOf(c), {
      entity: "note",
      action: "create",
      values: toRow({ ...body, ...size, ...spot }),
    });
    return c.json(await noteResponse(db, result), 201);
  })
  .patch("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const body = await jsonBody(c, updateNote);
    const note = await getRow(db, "note", id);
    if (!note) throw new NotFoundError(`No note with id ${id}.`);
    await checkLabelId(db, body.label_id, note.label_id);
    const result = await mutate(db, actorOf(c), { entity: "note", action: "update", id, patch: toRow(body) });
    return c.json(await noteResponse(db, result));
  })
  .post("/:id/archive", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "note", action: "archive", id: c.req.param("id") });
    return c.json(await noteResponse(db, result));
  })
  .post("/:id/unarchive", async (c) => {
    const db = c.env.DB;
    const result = await mutate(db, actorOf(c), { entity: "note", action: "unarchive", id: c.req.param("id") });
    return c.json(await noteResponse(db, result));
  });
