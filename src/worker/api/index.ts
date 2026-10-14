import { Hono } from "hono";
import type { AppBindings } from "../env";

/** Board API, mounted at /api behind the session check (src/worker/app.ts). */
export const apiRouter = new Hono<AppBindings>();
