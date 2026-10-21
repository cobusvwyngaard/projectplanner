// /api/links: link two items (note↔task, note↔note, task↔task) and unlink them.
//
// A link is either a plain connection or a dependency between two tasks: the
// one that must be done first, and the one that waits for it.

import { Hono } from "hono";
import { z } from "zod";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { ValidationError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate, type Dependency } from "../mutate/index";
import { actorOf, mutationResponse } from "./request";
import type { ItemRef } from "../../shared/types";

const itemRef = z.strictObject({
  type: z.enum(["note", "task"], "An item is either a note or a task."),
  id: fields.id,
});

/** A dependency between two tasks: the one that must be done first, and the one that waits. */
const depends = z.strictObject({ before: itemRef, after: itemRef });

/** A plain connection, or a dependency between two tasks. */
const createLink = z
  .strictObject({ a: itemRef.optional(), b: itemRef.optional(), depends: depends.optional() })
  .refine(
    (body) => (body.depends !== undefined) !== (body.a !== undefined || body.b !== undefined),
    "Give either a and b, or depends with before and after.",
  );

/** A link's direction: a plain connection, or a dependency between two tasks. */
const updateLink = z
  .strictObject({ direction: z.literal("none").optional(), depends: depends.optional() })
  .refine(
    (body) => (body.depends !== undefined) !== (body.direction !== undefined),
    "Give either direction 'none', or depends with before and after.",
  );

type LinkMutation =
  | { entity: "link"; action: "link"; a: ItemRef; b: ItemRef }
  | { entity: "link"; action: "link"; depends: Dependency };

/** The link a body asks for. The schema has already made sure of it. */
function linkMutation(body: {
  a?: ItemRef;
  b?: ItemRef;
  depends?: Dependency;
}): LinkMutation {
  if (body.depends !== undefined) return { entity: "link", action: "link", depends: body.depends };
  if (body.a !== undefined && body.b !== undefined) return { entity: "link", action: "link", a: body.a, b: body.b };
  throw new ValidationError("Give either a and b, or depends with before and after.");
}

export const linksRouter = new Hono<AppBindings>()
  .post("/", async (c) => {
    // Linking an already linked pair changes the direction it has, if any,
    // and returns the link.
    const mutation = linkMutation(await jsonBody(c, createLink));
    const result = await mutate(c.env.DB, actorOf(c), mutation);
    return c.json(mutationResponse("link", result));
  })
  .patch("/:id", async (c) => {
    const body = await jsonBody(c, updateLink);
    const id = c.req.param("id");
    const result = await mutate(
      c.env.DB,
      actorOf(c),
      body.depends !== undefined
        ? { entity: "link", action: "relink", id, depends: body.depends }
        : { entity: "link", action: "relink", id, related: true },
    );
    return c.json(mutationResponse("link", result));
  })
  .post("/:id/unlink", async (c) => {
    const result = await mutate(c.env.DB, actorOf(c), { entity: "link", action: "unlink", id: c.req.param("id") });
    return c.json(mutationResponse("link", result));
  });
