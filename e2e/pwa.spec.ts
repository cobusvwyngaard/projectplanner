// SPEC 6.1 and Phase 5: the manifest links the app for the home screen, the
// service worker takes over once signed in, and offline it says so instead
// of answering from a cache.

import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("once signed in, the manifest is linked and the service worker is ready", async ({ page }) => {
  await signIn(page, 1);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const ready = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  expect(ready).toBe(true);
});

test("offline, the board says so and the API is never answered from a cache", async ({ page, context }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // The worker claims the open pages on activation, so it controls this one.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("The planner needs a connection; it will load again when you're back online.")).toBeVisible();

  const answered = await page.evaluate(() => fetch("/api/bootstrap").then(() => "answered", () => "failed"));
  expect(answered).toBe("failed");
});
