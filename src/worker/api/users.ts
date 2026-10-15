// /api/users: change a person's display name and initials (Settings).

import { Hono } from "hono";
import { z } from "zod";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { actorOf, mutationResponse, toRow } from "./request";

const updateUser = z.strictObject({
  display_name: fields.displayName.optional(),
  initials: fields.initials.optional(),
});

export const usersRouter = new Hono<AppBindings>().patch("/:id", async (c) => {
  const body = await jsonBody(c, updateUser);
  const result = await mutate(c.env.DB, actorOf(c), {
    entity: "user",
    action: "update",
    id: c.req.param("id"),
    patch: toRow(body),
  });
  return c.json(mutationResponse("user", result));
});
