// /api/runs: Claude's runs for the Activity view, one run in detail, and
// reverting a whole run.

import { Hono } from "hono";
import { z } from "zod";
import type { RunsResponse } from "../../shared/api";
import { listRuns, runDetail } from "../board/runs";
import type { AppBindings } from "../env";
import { revertRun } from "../mutate/revert";
import { actorOf, optionalJsonBody, queryParams, revertBody, revertResponse } from "./request";

const runsQuery = z.strictObject({
  before: z.iso.datetime("Use the started_at time of the last run shown.").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const runsRouter = new Hono<AppBindings>()
  .get("/", async (c) => {
    const response: RunsResponse = { runs: await listRuns(c.env.DB, queryParams(c, runsQuery)) };
    return c.json(response);
  })
  .get("/:id", async (c) => c.json(await runDetail(c.env.DB, c.req.param("id"))))
  .post("/:id/revert", async (c) => {
    const { confirm } = await optionalJsonBody(c, revertBody);
    const outcome = await revertRun(c.env.DB, actorOf(c), c.req.param("id"), { confirm: confirm === true });
    return c.json(revertResponse(outcome));
  });
