// /api/labels: create, rename, recolour, reorder, archive and unarchive labels.

import { Hono } from "hono";
import { z } from "zod";
import type { Label } from "../../shared/types";
import { activeLabels, getRow, listLabels } from "../board/queries";
import { checkLabelNameFree, fields } from "../board/validation";
import type { AppBindings } from "../env";
import { NotFoundError, ValidationError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate, mutateMany, type Mutation } from "../mutate/index";
import { readSettings, settingMutation } from "../settings";
import { actorOf, mutationResponse, toRow } from "./request";

const createLabel = z.strictObject({ name: fields.labelName, colour_hex: fields.colour });
const updateLabel = z.strictObject({ name: fields.labelName.optional(), colour_hex: fields.colour.optional() });
const reorderLabels = z.strictObject({ ids: z.array(fields.id).max(500, "That is too many labels.") });

async function requireLabel(db: D1Database, id: string): Promise<Label> {
  const label = await getRow(db, "label", id);
  if (!label) throw new NotFoundError(`No label with id ${id}.`);
  return label;
}

export const labelsRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    const db = c.env.DB;
    const body = await jsonBody(c, createLabel);
    await checkLabelNameFree(db, body.name);
    // New labels go to the end of the list.
    const last = await db.prepare(`SELECT MAX(sort_order) AS n FROM labels`).first<{ n: number | null }>();
    const result = await mutate(db, actorOf(c), {
      entity: "label",
      action: "create",
      values: { ...body, sort_order: (last?.n ?? -1) + 1 },
    });
    return c.json(mutationResponse("label", result), 201);
  })
  .post("/reorder", async (c) => {
    const db = c.env.DB;
    const { ids } = await jsonBody(c, reorderLabels);
    const active = await activeLabels(db);
    const activeIds = new Set(active.map((l) => l.id));
    const exact = ids.length === active.length && new Set(ids).size === ids.length && ids.every((id) => activeIds.has(id));
    if (!exact) throw new ValidationError("List every label that is not archived exactly once.", { field: "ids" });
    // One transaction: the new order applies completely or not at all.
    await mutateMany(
      db,
      actorOf(c),
      ids.map((id, index): Mutation => ({ entity: "label", action: "update", id, patch: { sort_order: index } })),
    );
    return c.json({ labels: await listLabels(db) });
  })
  .patch("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const body = await jsonBody(c, updateLabel);
    const label = await requireLabel(db, id);
    if (body.name !== undefined && label.archived_at === null) await checkLabelNameFree(db, body.name, id);
    const result = await mutate(db, actorOf(c), { entity: "label", action: "update", id, patch: toRow(body) });
    return c.json(mutationResponse("label", result));
  })
  .post("/:id/archive", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    await requireLabel(db, id);
    const mutations: Mutation[] = [{ entity: "label", action: "archive", id }];
    // An archived label cannot stay the default for new items.
    if ((await readSettings(db)).default_label_id === id) {
      mutations.push(await settingMutation(db, "default_label_id", null));
    }
    const [result] = await mutateMany(db, actorOf(c), mutations);
    if (!result) throw new Error("mutateMany returned no result");
    return c.json(mutationResponse("label", result));
  })
  .post("/:id/unarchive", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const label = await requireLabel(db, id);
    if (label.archived_at !== null) await checkLabelNameFree(db, label.name, id);
    const result = await mutate(db, actorOf(c), { entity: "label", action: "unarchive", id });
    return c.json(mutationResponse("label", result));
  });
