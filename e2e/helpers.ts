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
