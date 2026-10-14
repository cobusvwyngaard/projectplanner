// /api/bootstrap (the first load) and /api/changes (the 5-second poll).

import { Hono } from "hono";
import { z } from "zod";
import { loadBootstrap, loadChanges } from "../board/feed";
import { fields } from "../board/validation";
import type { AppBindings } from "../env";
import { queryParams } from "./request";

const changesQuery = z.strictObject({ since: fields.id.optional() });

export const feedRouter = new Hono<AppBindings>()
  .get("/bootstrap", async (c) => c.json(await loadBootstrap(c.env.DB, c.get("user"))))
  .get("/changes", async (c) => {
    const { since } = queryParams(c, changesQuery);
    return c.json(await loadChanges(c.env.DB, since));
  });
