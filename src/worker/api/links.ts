// /api/links: link two items (note↔task, note↔note, task↔task) and unlink them.

import { Hono } from "hono";
import { z } from "zod";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { actorOf, mutationResponse } from "./request";

const itemRef = z.strictObject({
  type: z.enum(["note", "task"], "An item is either a note or a task."),
  id: fields.id,
});

const createLink = z.strictObject({ a: itemRef, b: itemRef });

export const linksRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    const { a, b } = await jsonBody(c, createLink);
    // Linking an already linked pair changes nothing and returns the link.
    const result = await mutate(c.env.DB, actorOf(c), { entity: "link", action: "link", a, b });
    return c.json(mutationResponse("link", result));
  })
  .post("/:id/unlink", async (c) => {
    const result = await mutate(c.env.DB, actorOf(c), { entity: "link", action: "unlink", id: c.req.param("id") });
    return c.json(mutationResponse("link", result));
  });
