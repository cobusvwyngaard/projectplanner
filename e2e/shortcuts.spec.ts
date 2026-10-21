// Phase 5: keyboard shortcuts on the board. They work with focus on the
// board, never while typing in a field.

import { expect, test } from "@playwright/test";
import { freeBoardPoint, signIn, unique } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  // Cards left by earlier tests can sit at the centre; click empty board so
  // the pane keeps focus and no item panel opens.
  const point = await freeBoardPoint(page);
  await page.mouse.click(point.x, point.y);
});

test("N on the board adds a note", async ({ page }) => {
  const before = await page.locator(".react-flow__node-note").count();
  await page.keyboard.press("n");
  const panel = page.locator(".panel");
  await expect(panel.getByRole("heading", { name: "Note" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".react-flow__node-note")).toHaveCount(before + 1);
});

test("T on the board adds a task", async ({ page }) => {
  const title = unique("Sweep the steps");
  await page.keyboard.press("t");
  const form = page.locator(".board-toolbar .inline-form");
  await expect(form).toBeVisible();
  await form.getByLabel("New task title").fill(title);
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".react-flow__node-task").filter({ hasText: title })).toBeVisible();
});

test("? opens the shortcuts dialog and Escape closes it", async ({ page }) => {
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  // The keys the board already had are listed too.
  await expect(dialog.locator("kbd", { hasText: "Enter" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("typing n into a field does not add a note", async ({ page }) => {
  const before = await page.locator(".react-flow__node-note").count();
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const field = page.getByLabel("New task title");
  await field.press("n");
  await expect(field).toHaveValue("n");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.locator(".react-flow__node-note")).toHaveCount(before);
});
