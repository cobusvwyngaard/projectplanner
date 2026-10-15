// The OAuth consent step (SPEC 3.5). Mounted at /authorize behind the page
// session check, so whoever reaches it is signed in. The authorisation
// request is always parsed from the URL by the provider, on the POST as well
// as the GET: the consent form posts back to the same URL and carries only
// the person's decision.

import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { CONTENT_SECURITY_POLICY } from "../auth/headers";
import { escapeHtml, renderMessagePage, renderPage } from "../auth/html";
import { isCrossSite } from "../auth/middleware";
import type { AppBindings, GrantProps } from "../env";
import { isLoopbackHostname } from "../lib/http";
import { isAllowedRedirectUri } from "./redirects";

export const authorizeRouter = new Hono<AppBindings>();

/**
 * Runs before the session check and before the provider: a request whose
 * redirect_uri is not Claude's callback or a loopback address gets a plain
 * 400 page and is never redirected anywhere, not even to the phrase page.
 */
export const requireAllowedRedirect: MiddlewareHandler<AppBindings> = async (c, next) => {
  const redirectUri = new URL(c.req.url).searchParams.get("redirect_uri");
  if (redirectUri !== null && isAllowedRedirectUri(redirectUri)) return next();
  return c.html(
    renderMessagePage(
      "This planner only connects to Claude",
      "The link you followed asks to connect a different app. Nothing was connected or shared.",
    ),
    400,
  );
};

/**
 * Chrome applies form-action to the redirect that follows the form POST, so
 * the consent page also allows posting on to https: (claude.ai) and to an
 * http loopback redirect, for local tools.
 */
function consentPolicy(redirectUri: string): string {
  const url = new URL(redirectUri);
  const extra = url.protocol === "http:" && isLoopbackHostname(url.hostname) ? ` ${url.origin}` : "";
  return CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' https:${extra}`);
}

function invalidRequest(c: Context<AppBindings>): Response {
  return c.html(
    renderMessagePage(
      "This link does not work",
      "The app that sent you here made a request the planner cannot accept. Go back to the app and try connecting again.",
    ),
    400,
  );
}

/** The parsed request, or the response to send instead. */
async function parseRequest(c: Context<AppBindings>): Promise<AuthRequest | Response> {
  try {
    return await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    // The provider sets redirectTo only once the client and its redirect URI
    // are verified, and requireAllowedRedirect has allowed that URI.
    if (err.redirectTo) return c.redirect(err.redirectTo, 302);
    return invalidRequest(c);
  }
}

/** The client's own name, which it chose itself at registration, or its id. */
function clientName(client: ClientInfo): string {
  return client.clientName?.trim() || client.clientId;
}

function redirectHost(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.host || redirectUri;
}

authorizeRouter.get("/", async (c) => {
  const parsed = await parseRequest(c);
  if (parsed instanceof Response) return parsed;
  const client = await c.env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return invalidRequest(c);

  const user = c.get("user");
  const host = redirectHost(parsed.redirectUri);
  const loopback = isLoopbackHostname(new URL(parsed.redirectUri).hostname);
  const action = `/authorize${new URL(c.req.url).search}`;
  const warning = loopback
    ? `<p class="notice warning">This sends the connection to a program on this device. Only allow it if you started this yourself.</p>\n`
    : "";
  c.header("Content-Security-Policy", consentPolicy(parsed.redirectUri));
  return c.html(
    renderPage(
      "Allow access · Shared Planner",
      `<h1>Allow access?</h1>
<p>Allow <strong>${escapeHtml(clientName(client))}</strong> to read and change the planner on behalf of <strong>${escapeHtml(user.display_name)}</strong>?</p>
<p class="muted small">If you allow it, you will be sent on to <strong>${escapeHtml(host)}</strong>.</p>
${warning}<form method="post" action="${escapeHtml(action)}">
<div class="actions">
<button type="submit" name="decision" value="cancel" class="secondary">Cancel</button>
<button type="submit" name="decision" value="allow">Allow</button>
</div>
</form>`,
    ),
  );
});

authorizeRouter.post("/", async (c) => {
  if (isCrossSite(c.req.raw)) {
    return c.html(renderMessagePage("Not allowed", "Give access from the planner's own page."), 403);
  }
  const parsed = await parseRequest(c);
  if (parsed instanceof Response) return parsed;
  const form = await c.req.parseBody();

  if (form.decision === "cancel") {
    return c.redirect(authorizationErrorRedirect(parsed, "access_denied"), 302);
  }
  if (form.decision !== "allow") return invalidRequest(c);

  const client = await c.env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return invalidRequest(c);
  const user = c.get("user");
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed,
    userId: user.id,
    metadata: { label: clientName(client) },
    scope: parsed.scope,
    props: { userId: user.id } satisfies GrantProps,
  });
  return c.redirect(redirectTo, 302);
});
