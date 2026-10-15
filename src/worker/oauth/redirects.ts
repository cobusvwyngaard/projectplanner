// Where the planner sends OAuth answers. It connects only to Claude and, for
// local tools such as MCP Inspector, to a program on the same device. Every
// other redirect URI is refused before the OAuth provider sees it, so the
// planner's address can never bounce a browser to someone else's site.

import { isLoopbackHostname } from "../lib/http";

/** Claude's OAuth callbacks, compared as origin + path (a query is allowed). */
export const CLAUDE_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** True for one of Claude's callbacks, or an http(s) address on this device. */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || uri.includes("#")) return false;
  if (CLAUDE_REDIRECT_URIS.includes(`${url.origin}${url.pathname}`)) return true;
  return (url.protocol === "https:" || url.protocol === "http:") && isLoopbackHostname(url.hostname);
}

/**
 * A dynamic client registration (RFC 7591) that lists any other redirect URI
 * is refused here with a 400; null lets the provider handle the request
 * (it also answers malformed ones).
 */
export async function refuseForeignRegistration(request: Request): Promise<Response | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  const uris = typeof body === "object" && body !== null ? (body as { redirect_uris?: unknown }).redirect_uris : undefined;
  if (!Array.isArray(uris)) return null;
  if (uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))) return null;
  return Response.json(
    {
      error: "invalid_redirect_uri",
      error_description: "This planner only connects to Claude: redirect URIs must be Claude's callback or a loopback address.",
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
