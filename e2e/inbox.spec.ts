import { expect, test } from "@playwright/test";
import { unique, signIn } from "./helpers";

test("inbox shows captures and filters", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/inbox");
  // Empty state possible; just ensure the view renders.
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  // The default filter is New, and the selected filter is marked.
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("quick text capture appears in inbox", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await page.getByRole("button", { name: "Record" }).first().click();
  await page.getByRole("button", { name: "Quick text" }).click();
  const text = unique("inbox quick text");
  await page.getByPlaceholder("Type a note…").fill(text);
  await page.getByRole("button", { name: "Save" }).click();
  await page.goto("/inbox");
  await expect(page.locator(".capture-card").filter({ hasText: text })).toBeVisible();
});

test("ignore then back to inbox", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await page.getByRole("button", { name: "Record" }).first().click();
  await page.getByRole("button", { name: "Quick text" }).click();
  const text = unique("inbox ignore");
  await page.getByPlaceholder("Type a note…").fill(text);
  await page.getByRole("button", { name: "Save" }).click();
  await page.goto("/inbox");
  const card = page.locator(".capture-card").filter({ hasText: text });
  await card.getByRole("button", { name: "Ignore" }).click();
  await page.getByRole("button", { name: "Ignored" }).click();
  await expect(page.locator(".capture-card").filter({ hasText: text })).toBeVisible();
  await page.locator(".capture-card").filter({ hasText: text }).getByRole("button", { name: "Back to inbox" }).click();
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.locator(".capture-card").filter({ hasText: text })).toBeVisible();
});
