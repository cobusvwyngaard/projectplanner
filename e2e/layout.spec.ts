// Layout checks: who last changed a task stays readable on its card, and the
// Activity view's date filters fit a phone screen.

import { expect, test, type Locator } from "@playwright/test";
import type { MutationResponse } from "../src/shared/api";
import type { TaskView } from "../src/shared/types";
import { api, names, signedInPage, unique } from "./helpers";

/** True when everything inside the element is shown (nothing clipped or cut off with "…"). */
function fullyShown(element: Locator): Promise<boolean> {
  return element.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);
}

test("a task card shows who last changed it in full", async ({ browser }) => {
  const one = await signedInPage(browser, 1);
  const two = await signedInPage(browser, 2);
  const who = await names(one.page);
  const task = (await api<MutationResponse<TaskView>>(one.page, "POST", "/api/tasks", { title: unique("Paint the shed"), x: 40, y: 600 })).row;
  await api(two.page, "PATCH", `/api/tasks/${task.id}`, { detail: "Two coats" });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await one.page.setViewportSize(viewport);
    await one.page.goto("/board");
    const card = one.page.locator(`.react-flow__node[data-id="task:${task.id}"]`);
    await card.scrollIntoViewIfNeeded();
    const provenance = card.locator(".provenance");
    await expect(provenance).toContainText(who.p2);
    expect(await fullyShown(provenance), `${viewport.width} px`).toBe(true);
  }
  await one.context.close();
  await two.context.close();
});

test("the Activity date filters fit a 390 px phone", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, 2, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto("/activity");
  const filters = page.getByRole("group", { name: "Filters" });
  await expect(filters).toBeVisible();
  const card = await filters.boundingBox();
  if (!card) throw new Error("No filters.");
  for (const name of ["From", "To"]) {
    const box = await page.getByLabel(name, { exact: true }).boundingBox();
    if (!box) throw new Error(`No ${name} field.`);
    expect(box.x, name).toBeGreaterThanOrEqual(card.x);
    expect(box.x + box.width, name).toBeLessThanOrEqual(card.x + card.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await context.close();
});
