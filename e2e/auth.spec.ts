// SPEC 3 and 9: each phrase signs in as its person, a wrong phrase gets the
// generic message, the browser stays signed in, and a 401 goes to the phrase page.

import { expect, test } from "@playwright/test";
import { LOGIN_FAILED, PERSON_1, PERSON_2, bootstrap, phrase, signIn } from "./helpers";

test("phrase 1 signs in as Person 1 and returns to the page asked for", async ({ page }) => {
  await page.goto("/list");
  await expect(page).toHaveURL(/\/login\?next=%2Flist$/);
  await page.getByLabel("Enter your phrase").fill(phrase(1));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/list$/);
  const { me } = await bootstrap(page);
  expect(me.id).toBe(PERSON_1);
  await expect(page.locator(".me")).toHaveAttribute("title", `Signed in as ${me.display_name}`);
  await expect(page.locator(".me")).toHaveText(me.initials);
});

test("the phrase can be shown and hidden while typing, and signing in still works", async ({ page }) => {
  await page.goto("/login");
  const field = page.getByLabel("Enter your phrase");
  await field.fill(phrase(1));
  await expect(field).toHaveAttribute("type", "password");
  await field.evaluate((el) => {
    if (el instanceof HTMLInputElement) el.setSelectionRange(1, 1);
  });

  const show = page.getByRole("button", { name: "Show phrase" });
  await expect(show).toBeVisible();
  await show.click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue(phrase(1));
  await expect(page.getByRole("button", { name: "Hide phrase" })).toHaveAttribute("aria-pressed", "true");
  await expect(field).toBeFocused();
  const cursor = await field.evaluate((el) => {
    if (!(el instanceof HTMLInputElement)) return null;
    return [el.selectionStart, el.selectionEnd];
  });
  expect(cursor).toEqual([1, 1]);

  await page.getByRole("button", { name: "Hide phrase" }).click();
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveValue(phrase(1));
  await expect(page.getByRole("button", { name: "Show phrase" })).toHaveAttribute("aria-pressed", "false");

  // Shown once more, then the form still signs in.
  await page.getByRole("button", { name: "Show phrase" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  expect((await bootstrap(page)).me.id).toBe(PERSON_1);
});

test("phrase 2 signs in as Person 2", async ({ page }) => {
  await signIn(page, 2);
  const { me } = await bootstrap(page);
  expect(me.id).toBe(PERSON_2);
  await expect(page.locator(".me")).toHaveText(me.initials);
});

test("a wrong phrase shows the generic message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Enter your phrase").fill("certainly not a real phrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(LOGIN_FAILED);
  await expect(page.locator(".app-header")).toHaveCount(0);
});

test("the browser stays signed in across restarts", async ({ browser }, testInfo) => {
  const first = await browser.newContext();
  const page = await first.newPage();
  await signIn(page, 1);
  const [cookie] = (await first.cookies()).filter((c) => c.name === "__Host-planner_session");
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  // Long-lived: the cookie outlives the browser (400 days, refreshed on use).
  expect(cookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1000 + 300 * 86_400);
  const saved = testInfo.outputPath("state.json");
  await first.storageState({ path: saved });
  await first.close();

  const restarted = await browser.newContext({ storageState: saved });
  const again = await restarted.newPage();
  await again.goto("/");
  await expect(again.locator(".app-header")).toBeVisible();
  await expect(again).not.toHaveURL(/\/login/);
  expect((await bootstrap(again)).me.id).toBe(PERSON_1);
  await restarted.close();
});

test("a 401 from the API sends the browser to the phrase page", async ({ page, context }) => {
  await signIn(page, 1);
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  // The session ends (as if signed out elsewhere); the next poll gets a 401.
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/login\?next=%2Factivity$/);
});
