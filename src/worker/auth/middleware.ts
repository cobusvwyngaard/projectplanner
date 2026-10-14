// Session and same-origin checks for the Hono app (SPEC 3.4).

import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { AppError, ForbiddenError } from "../lib/errors";
import { jsonError } from "../lib/http";
import { SESSION_COOKIE, readSessionToken, sessionCookie, validateSession } from "./sessions";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Where the login page sends the browser back to: this request's path and query. */
function loginRedirectUrl(c: Context): string {
  const url = new URL(c.req.url);
  return `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
}

/** True when a handler already set (or cleared) the session cookie on its response. */
function setsSessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
}

function sessionGate(onMissing: (c: Context<AppBindings>) => Response): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = readSessionToken(c.req.raw);
    const valid = token === null ? null : await validateSession(c.env.DB, token);
    if (token === null || valid === null) return onMissing(c);
    c.set("user", valid.user);
    c.set("sessionId", valid.session.id);
    await next();
    // Sliding expiry: send the cookie again whenever last_seen_at moved on,
    // unless the handler signed this browser out.
    if (valid.refreshed && !setsSessionCookie(c.res)) {
      c.header("Set-Cookie", sessionCookie(token), { append: true });
    }
    return undefined;
  };
}

/** /api/*: no valid session is a 401 JSON error, whatever the path. */
export const requireApiSession = sessionGate((c) =>
  jsonError(new AppError(401, "unauthorised", "Please sign in to continue."), c),
);

/** Pages and /authorize: no valid session sends the browser to the phrase page, then back. */
export const requirePageSession = sessionGate((c) => c.redirect(loginRedirectUrl(c), 302));

/**
 * Changes must come from this site: refuse an Origin header that is present
 * and not this origin, and anything the browser marks as cross-site.
 */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return true;
  return request.headers.get("Sec-Fetch-Site") === "cross-site";
}

/** For /api/*: refuse cross-site POST, PUT, PATCH and DELETE requests. */
export const requireSameOrigin: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (UNSAFE_METHODS.has(c.req.method) && isCrossSite(c.req.raw)) {
    throw new ForbiddenError("Changes must come from the planner itself.");
  }
  await next();
};
