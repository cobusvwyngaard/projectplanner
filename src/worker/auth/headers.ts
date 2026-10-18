// Security and caching headers for every response the Hono app builds.

import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { isLoopbackHostname } from "../lib/http";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const FIXED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"],
  ["X-Frame-Options", "DENY"],
  ["Permissions-Policy", "microphone=(self), camera=(), geolocation=()"],
];

/** Browsers that have seen this stay on https for a year (not sent on localhost). */
const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

/** Files anyone may fetch: they carry no data and the browser needs them before signing in. */
export const PUBLIC_FILES = ["/manifest.webmanifest", "/sw.js", "/favicon.svg", "/icons/*"] as const;

function isPublicFile(path: string): boolean {
  return PUBLIC_FILES.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));
}

function cacheControl(path: string, status: number): string {
  // Vite puts a content hash in every file name under /assets/.
  if (path.startsWith("/assets/") && status === 200) return "public, max-age=31536000, immutable";
  if (isPublicFile(path) && status < 400) return "no-cache";
  return "no-store";
}

/**
 * Adds the security headers (HSTS on https) and Cache-Control to the final
 * response. A handler may set its own Content-Security-Policy (the consent
 * page does); the other headers are always these.
 */
export const securityHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  // Responses from fetch() have immutable headers, so work on a copy.
  const res = new Response(c.res.body, c.res);
  if (!res.headers.has("Content-Security-Policy")) res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  for (const [name, value] of FIXED_HEADERS) res.headers.set(name, value);
  const url = new URL(c.req.url);
  if (url.protocol === "https:" && !isLoopbackHostname(url.hostname)) {
    res.headers.set("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  }
  const isAudio = /^\/api\/captures\/[^/]+\/audio$/.test(c.req.path);
  const successAudio = isAudio && (res.status === 200 || res.status === 206);
  if (!successAudio) {
    res.headers.set("Cache-Control", cacheControl(c.req.path, res.status));
  }
  // Clear first: assigning over an existing response copies its headers back in.
  c.res = undefined;
  c.res = res;
};
