// /api/users: change a person's display name and initials, and register an
// email address for them (Settings). /api/user-emails archives one.

import { Hono } from "hono";
import { z } from "zod";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { ConflictError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { actorOf, mutationResponse, toRow } from "./request";

const updateUser = z.strictObject({
  display_name: fields.displayName.optional(),
  initials: fields.initials.optional(),
});

const createEmail = z.strictObject({
  address: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("That does not look like an email address.")),
});

export const usersRouter = new Hono<AppBindings>()
  .patch("/:id", async (c) => {
    const body = await jsonBody(c, updateUser);
    const result = await mutate(c.env.DB, actorOf(c), {
      entity: "user",
      action: "update",
      id: c.req.param("id"),
      patch: toRow(body),
    });
    return c.json(mutationResponse("user", result));
  })
  .post("/:id/emails", async (c) => {
    const db = c.env.DB;
    const body = await jsonBody(c, createEmail);
    // mutate() reads a UNIQUE failure as a stale write (the open-address index),
    // so look first to give the person the person's name instead.
    const clash = await db
      .prepare(
        `SELECT u.display_name FROM user_emails e JOIN users u ON u.id = e.user_id
         WHERE e.address = ? AND e.archived_at IS NULL`,
      )
      .bind(body.address)
      .first<{ display_name: string }>();
    if (clash) throw new ConflictError(`That address already belongs to ${clash.display_name}.`);
    const result = await mutate(db, actorOf(c), {
      entity: "user_email",
      action: "create",
      values: { user_id: c.req.param("id"), address: body.address },
    });
    return c.json(mutationResponse("user_email", result), 201);
  });

/** /api/user-emails: archive a registered address, freeing it for reuse (SPEC 11.2). */
export const userEmailsRouter = new Hono<AppBindings>().post("/:id/archive", async (c) => {
  const result = await mutate(c.env.DB, actorOf(c), {
    entity: "user_email",
    action: "archive",
    id: c.req.param("id"),
  });
  return c.json(mutationResponse("user_email", result));
});
