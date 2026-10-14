// The phrase page (SPEC 3.1): one field, one button, no usernames, no email,
// no reset. Every failure, lockouts included, shows the same message.

import { escapeHtml, renderPage } from "./html";

export const LOGIN_FAILED_MESSAGE = "That didn't work. Check your phrase and try again in a little while.";

export function renderLoginPage(options: { next: string; failed: boolean }): string {
  const error = options.failed ? `<p class="notice error" role="alert">${escapeHtml(LOGIN_FAILED_MESSAGE)}</p>\n` : "";
  return renderPage(
    "Sign in · Shared Planner",
    `<h1>Shared Planner</h1>
<p class="muted">Welcome back.</p>
${error}<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<label for="phrase">Enter your phrase</label>
<input id="phrase" name="phrase" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" autofocus required>
<button type="submit">Sign in</button>
</form>`,
  );
}

const MAX_NEXT_LENGTH = 2048;

/**
 * A safe place to go after signing in: a path on this site ("/..."), never
 * another origin ("//host", "/\host"). Control characters and backslashes
 * are refused anywhere, because browsers drop or reinterpret them. Anything
 * else becomes "/".
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_NEXT_LENGTH) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  return value;
}
