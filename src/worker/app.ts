// The Hono app: every request the OAuth provider does not handle itself
// (see docs/architecture.md). Public: the phrase page, sign-out and the files
// a browser needs before signing in. Everything else needs a session.

import { Hono } from "hono";
import { securityHeaders, PUBLIC_FILES } from "./auth/headers";
import { renderMessagePage } from "./auth/html";
import { requireApiSession, requirePageSession, requireSameOrigin } from "./auth/middleware";
import { authRouter } from "./auth/routes";
import { apiRouter } from "./api/index";
import { sessionsRouter } from "./api/sessions";
import type { AppBindings } from "./env";
import { NotFoundError } from "./lib/errors";
import { jsonError } from "./lib/http";
import { authorizeRouter } from "./oauth/authorize";

export const app = new Hono<AppBindings>();

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

app.use("*", securityHeaders);

app.route("/", authRouter);

for (const path of PUBLIC_FILES) {
  app.on(["GET", "HEAD"], path, (c) => c.env.ASSETS.fetch(c.req.raw));
}

// The session check runs before any /api routing, so unknown paths and audio
// are a 401 like everything else without a session.
app.use("/api/*", requireApiSession, requireSameOrigin);
app.route("/api/sessions", sessionsRouter);
app.route("/api", apiRouter);
// Ends the chain for unknown /api paths so they never reach the app shell below.
app.all("/api/*", () => {
  throw new NotFoundError("No such API route.");
});

app.use("/authorize", requirePageSession);
app.route("/authorize", authorizeRouter);

// The single-page app. Wrangler's not_found_handling serves index.html for
// client-side routes such as /board.
app.use("*", requirePageSession);
app.on(["GET", "HEAD"], "*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Reached by methods other than GET and HEAD on pages; /api has its own 404 above.
app.notFound((c) => c.html(renderMessagePage("Not found", "There is nothing at this address."), 404));

app.onError((err, c) => {
  if (isApiPath(c.req.path)) return jsonError(err, c);
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`${c.req.method} ${c.req.path} failed: ${e.name}: ${e.message}`);
  return c.html(renderMessagePage("Something went wrong", "Please try again in a moment."), 500);
});
