// Shared helpers for the smoke tests: the local phrases (read from .dev.vars,
// never printed), signing in, and small API calls for setting up and checking
// data. Every name and text the tests create is made up.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import type { BootstrapResponse, HistoryResponse } from "../src/shared/api";
import type { PlannerEvent } from "../src/shared/types";

export const PERSON_1 = "00000000000000000000000001";
export const PERSON_2 = "00000000000000000000000002";

/** The message the phrase page shows for every failed sign-in. */
export const LOGIN_FAILED = "That didn't work. Check your phrase and try again in a little while.";

function readDevVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  const text = readFileSync(join(import.meta.dirname, "..", ".dev.vars"), "utf8");
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    vars[match[1]] = (match[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return vars;
}

/** LOGIN_PHRASE_1 or LOGIN_PHRASE_2 from .dev.vars. */
export function phrase(person: 1 | 2): string {
  const value = readDevVars()[`LOGIN_PHRASE_${person}`];
  if (!value) throw new Error(`LOGIN_PHRASE_${person} is missing from .dev.vars (copy .dev.vars.example).`);
  return value;
}

/** Sign in on the phrase page and wait for the app. */
export async function signIn(page: Page, person: 1 | 2): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Enter your phrase").fill(phrase(person));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".app-header")).toBeVisible();
}

/** A new browser context (another browser, in effect) signed in as the person. */
export async function signedInPage(
  browser: Browser,
  person: 1 | 2,
  options: BrowserContextOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, person);
  return { context, page };
}

/** A made-up title that no other test uses. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

/** Call the app API with the page's session (for set-up and checks). */
export async function api<T>(page: Page, method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body, headers: { "Content-Type": "application/json" } }),
  });
  if (!response.ok()) throw new Error(`${method} ${path} answered ${response.status()}`);
  return (await response.json()) as T;
}

export function bootstrap(page: Page): Promise<BootstrapResponse> {
  return api<BootstrapResponse>(page, "GET", "/api/bootstrap");
}

/** Display names of both people, as they are now. */
export async function names(page: Page): Promise<{ p1: string; p2: string }> {
  const { users } = await bootstrap(page);
  const name = (id: string) => users.find((u) => u.id === id)?.display_name ?? "";
  return { p1: name(PERSON_1), p2: name(PERSON_2) };
}

export async function history(page: Page, type: "note" | "task", id: string): Promise<PlannerEvent[]> {
  return (await api<HistoryResponse>(page, "GET", `/api/history/${type}/${id}`)).events;
}

/** Updates of an item that changed only its position (moves on the canvas). */
export function moves(events: readonly PlannerEvent[]): PlannerEvent[] {
  return events.filter(
    (e) => e.action === "update" && e.after !== null && Object.keys(e.after).every((field) => field === "x" || field === "y"),
  );
}

// --- The Claude connector: a real OAuth client and MCP client, from Node ---
//
// The tests register a client whose redirect points at a loopback address
// (where nothing listens), let the signed-in browser allow it, catch the code
// from the redirect and exchange it for a token, then talk to /mcp the way a
// local tool would. Nothing here touches the app's own session.

/**
 * The loopback callback the test client registers; the browser never reaches
 * it. The port must not be one Chromium blocks (ERR_UNSAFE_PORT), so the
 * request actually reaches the route handler.
 */
export const CLAUDE_CALLBACK = "http://127.0.0.1:8765/callback";

export interface ClaudeToken {
  /** The client id it registered under. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Dynamic client registration (RFC 7591) for a tool on this device. */
async function registerClaudeClient(page: Page, clientName: string): Promise<string> {
  const response = await page.request.fetch("/register", {
    method: "POST",
    data: {
      client_name: clientName,
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  if (response.status() !== 201) throw new Error(`Claude client registration answered ${response.status()}`);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** Allow the connection in the signed-in browser and read the code off the consent redirect. */
async function allowClaudeClient(page: Page, baseURL: string, clientId: string, challenge: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope: "planner",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  }).toString();

  // The consent form redirects to the loopback address, where nothing listens,
  // so that navigation fails harmlessly after the code has come back. Anything
  // that does reach these routes (the consent page's own assets, re-resolved
  // against the loopback origin) is aborted, so no request leaves the machine.
  const callbackPattern = `${new URL(CLAUDE_CALLBACK).origin}/**`;
  await page.route(callbackPattern, (route) => route.abort());
  try {
    const redirect = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/authorize",
    );
    await page.goto(`/authorize?${query}`);
    // The redirect off the consent page is not always caught by a page route,
    // so the click may report a failed navigation; the 302 itself still lands.
    await page.getByRole("button", { name: "Allow" }).click().catch(() => undefined);
    const location = (await redirect).headers()["location"] ?? "";
    const code = new URL(location).searchParams.get("code");
    if (code === null) throw new Error("The consent redirect did not carry a code.");
    return code;
  } finally {
    await page.unroute(callbackPattern);
  }
}

/** Swap the code for tokens, as the local tool would. */
async function exchangeClaudeCode(
  page: Page,
  baseURL: string,
  clientId: string,
  code: string,
  verifier: string,
): Promise<ClaudeToken> {
  const response = await page.request.fetch("/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseURL}/mcp`,
    },
  });
  if (!response.ok()) throw new Error(`The token exchange answered ${response.status()}: ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** Register a Claude-like client, allow it in the signed-in browser and return its tokens. */
export async function connectClaude(page: Page, baseURL: string, clientName: string): Promise<ClaudeToken> {
  const clientId = await registerClaudeClient(page, clientName);
  const { verifier, challenge } = await pkce();
  const code = await allowClaudeClient(page, baseURL, clientId, challenge);
  return exchangeClaudeCode(page, baseURL, clientId, code, verifier);
}

function mcpHeaders(token: string, sessionId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;
  return headers;
}

interface RpcAnswer<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** The JSON-RPC message in a JSON or server-sent-events answer. */
async function rpcMessage<T>(response: Response): Promise<RpcAnswer<T>> {
  const text = await response.text();
  if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line.startsWith("{"));
    return JSON.parse(data ?? "{}") as RpcAnswer<T>;
  }
  return JSON.parse(text) as RpcAnswer<T>;
}

export interface McpToolOutcome<T> {
  /** The tool itself refused (an AppError or invalid input) */
  isError: boolean;
  /** The text of the result, joined from its parts */
  text: string;
  /** The text parsed as JSON, or null when it is not JSON */
  json: T | null;
}

/** One MCP session over /mcp, opened with a bearer token. */
export class McpClient {
  private sessionId: string | null = null;

  constructor(
    private readonly baseURL: string,
    private readonly token: string,
  ) {}

  /** initialize (which mints the session id), then say the client is ready. */
  async start(): Promise<void> {
    const response = await fetch(`${this.baseURL}/mcp`, {
      method: "POST",
      headers: mcpHeaders(this.token, null),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "playwright", version: "1.0.0" },
        },
      }),
    });
    if (response.status !== 200) throw new Error(`MCP initialize answered ${response.status}: ${await response.text()}`);
    this.sessionId = response.headers.get("mcp-session-id");
    await response.text();
    await fetch(`${this.baseURL}/mcp`, {
      method: "POST",
      headers: mcpHeaders(this.token, this.sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  /** Call a tool and report the outcome; a tool error is an outcome, not a throw. */
  async callTool<T = Record<string, unknown>>(name: string, args: unknown): Promise<McpToolOutcome<T>> {
    const response = await fetch(`${this.baseURL}/mcp`, {
      method: "POST",
      headers: mcpHeaders(this.token, this.sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    if (response.status !== 200) {
      throw new Error(`MCP tools/call ${name} answered ${response.status}: ${await response.text()}`);
    }
    const message = await rpcMessage<{ content?: { type: string; text: string }[]; isError?: boolean }>(response);
    if (message.error) throw new Error(`MCP tools/call ${name} failed: ${message.error.message}`);
    const text = (message.result?.content ?? []).map((part) => part.text).join("\n");
    let json: T | null = null;
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
    return { isError: message.result?.isError === true, text, json };
  }
}

/** The HTTP status of one tools/call, without throwing: 401 once a token is revoked. */
export async function mcpToolStatus(baseURL: string, token: string, name: string, args: unknown): Promise<number> {
  const response = await fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: mcpHeaders(token, null),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  await response.body?.cancel();
  return response.status;
}

/** A point on the canvas where a double-click or drop lands on the empty board. */
export async function freeBoardPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    if (!pane) return null;
    const box = pane.getBoundingClientRect();
    for (let y = box.top + 140; y < box.bottom - 140; y += 20) {
      for (let x = box.left + 160; x < box.right - 160; x += 20) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  if (!point) throw new Error("No free spot on the board.");
  return point;
}
