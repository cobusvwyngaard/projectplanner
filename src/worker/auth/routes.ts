// /login and /logout (SPEC 3.1 to 3.3).

import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { renderLoginPage, safeNext } from "./login-page";
import { renderMessagePage } from "./html";
import { isCrossSite } from "./middleware";
import { matchPhrase } from "./phrase";
import { beginAttempt, clientKey, recordFailure, recordSuccess } from "./rate-limit";
import {
  clearedSessionCookie,
  createSession,
  readSessionToken,
  revokeSession,
  sessionCookie,
  validateSession,
} from "./sessions";
import { PHRASE_USERS } from "./users";

export const authRouter = new Hono<AppBindings>();

function failed(c: Context<AppBindings>, next: string): Response {
  return c.html(renderLoginPage({ next, failed: true }), 401);
}

authRouter.on(["GET", "HEAD"], "/login", async (c) => {
  const next = safeNext(c.req.query("next"));
  const token = readSessionToken(c.req.raw);
  const valid = token === null ? null : await validateSession(c.env.DB, token);
  if (token !== null && valid !== null) {
    if (valid.refreshed) c.header("Set-Cookie", sessionCookie(token));
    return c.redirect(next, 303);
  }
  return c.html(renderLoginPage({ next, failed: false }));
});

authRouter.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  // A sign-in posted from another site is refused uncounted, so no other
  // site can lock this address out by posting wrong phrases.
  if (isCrossSite(c.req.raw)) return failed(c, next);

  const phrase = typeof form.phrase === "string" ? form.phrase : "";
  const now = new Date();
  const attempt = await beginAttempt(c.env.DB, clientKey(c.req.raw), now);
  // While locked out the phrase is not even looked at.
  if (attempt === null) return failed(c, next);
  const which = await matchPhrase(c.env, phrase);
  if (which === null) {
    await recordFailure(c.env.DB, attempt, now);
    return failed(c, next);
  }

  await recordSuccess(c.env.DB, attempt.key);
  const { token } = await createSession(c.env.DB, PHRASE_USERS[which], c.req.header("User-Agent") ?? null, now);
  c.header("Set-Cookie", sessionCookie(token));
  return c.redirect(next, 303);
});

authRouter.post("/logout", async (c) => {
  if (isCrossSite(c.req.raw)) {
    return c.html(renderMessagePage("Not signed out", "Sign out from the planner itself."), 403);
  }
  const token = readSessionToken(c.req.raw);
  const valid = token === null ? null : await validateSession(c.env.DB, token);
  if (valid !== null) await revokeSession(c.env.DB, valid.user.id, valid.session.id);
  c.header("Set-Cookie", clearedSessionCookie());
  return c.redirect("/login", 303);
});
