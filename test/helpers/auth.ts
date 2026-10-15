// Helpers for tests that call the real Worker over HTTP.

import { SELF } from "cloudflare:test";
import { SESSION_COOKIE } from "../../src/worker/auth/sessions";

export const ORIGIN = "https://planner.test";

/** The phrases set as test bindings in vitest.config.ts (obvious placeholders). */
export const PHRASE_1 = "Test Phrase One";
export const PHRASE_2 = "test   phrase two";

let ipCounter = 0;

/** A fresh client address, so rate-limit state never leaks between tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

/** Call the Worker without following redirects. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });
}

export interface LoginOptions {
  ip?: string;
  next?: string;
  userAgent?: string;
  origin?: string;
}

/** POST /login the way the phrase page's form does. */
export function postLogin(phrase: string, options: LoginOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: options.origin ?? ORIGIN,
    "CF-Connecting-IP": options.ip ?? freshIp(),
  };
  if (options.userAgent !== undefined) headers["User-Agent"] = options.userAgent;
  const body = new URLSearchParams({ phrase });
  if (options.next !== undefined) body.set("next", options.next);
  return call("/login", { method: "POST", headers, body: body.toString() });
}

/** The session token a response sets, if any. */
export function sessionTokenFrom(res: Response): string | null {
  for (const cookie of res.headers.getSetCookie()) {
    if (!cookie.startsWith(`${SESSION_COOKIE}=`)) continue;
    const value = cookie.slice(SESSION_COOKIE.length + 1).split(";")[0] ?? "";
    return value === "" ? null : value;
  }
  return null;
}

export interface SignedIn {
  token: string;
  /** Value for a Cookie request header */
  cookie: string;
}

/** Sign in with a phrase and return the session cookie. */
export async function signIn(phrase: string = PHRASE_1, options: LoginOptions = {}): Promise<SignedIn> {
  const res = await postLogin(phrase, options);
  const token = sessionTokenFrom(res);
  if (res.status !== 303 || token === null) throw new Error(`Sign-in failed with status ${res.status}`);
  return { token, cookie: `${SESSION_COOKIE}=${token}` };
}

/** Same-origin request headers with a session cookie. */
export function withSession(session: SignedIn, headers: Record<string, string> = {}): Record<string, string> {
  return { Cookie: session.cookie, Origin: ORIGIN, ...headers };
}
