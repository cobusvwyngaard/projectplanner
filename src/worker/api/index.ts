import { Hono } from "hono";
import type { AppBindings } from "../env";
import { jsonError } from "../lib/http";
import { eventsRouter, historyRouter } from "./events";
import { feedRouter } from "./feed";
import { labelsRouter } from "./labels";
import { linksRouter } from "./links";
import { notesRouter } from "./notes";
import { runsRouter } from "./runs";
import { settingsRouter } from "./settings";
import { tasksRouter } from "./tasks";
import { usersRouter } from "./users";

/**
 * Board API, mounted at /api behind the session check (src/worker/app.ts).
 * c.get("user") is the signed-in person; every write is theirs. Errors become
 * JSON error bodies here too, so the routes behave the same wherever the
 * router is mounted.
 */
export const apiRouter = new Hono<AppBindings>()
  .route("/", feedRouter)
  .route("/notes", notesRouter)
  .route("/tasks", tasksRouter)
  .route("/links", linksRouter)
  .route("/labels", labelsRouter)
  .route("/users", usersRouter)
  .route("/settings", settingsRouter)
  .route("/events", eventsRouter)
  .route("/history", historyRouter)
  .route("/runs", runsRouter);

apiRouter.onError(jsonError);
