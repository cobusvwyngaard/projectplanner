// The item panel: a due date typed with the keyboard, closing the panel with
// Back, and where focus goes when it closes.

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { MutationResponse } from "../src/shared/api";
import type { TaskView } from "../src/shared/types";
import { api, bootstrap, history, signIn, signedInPage, unique } from "./helpers";

const panel = (page: Page) => page.locator(".panel");

async function newTask(page: Page, body: Record<string, unknown> = {}): Promise<TaskView> {
  return (await api<MutationResponse<TaskView>>(page, "POST", "/api/tasks", { title: unique("Fix the gate"), ...body })).row;
}

async function current(page: Page, id: string): Promise<TaskView | undefined> {
  return (await bootstrap(page)).tasks.find((t) => t.id === id);
}

/** Every PATCH of the task the page sends, and the status it got. */
function watchSaves(page: Page, id: string): { body: string; status: number }[] {
  const saves: { body: string; status: number }[] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() === "PATCH" && request.url().endsWith(`/api/tasks/${id}`)) {
      saves.push({ body: request.postData() ?? "", status: response.status() });
    }
  });
  return saves;
}

type DatePart = "year" | "month" | "day";

/**
 * The order of a date input's parts in this browser. Chromium takes it from
 * its own language, not the page's locale, so it is found with a probe:
 * "02", "03", "2004" typed into an empty date input.
 */
async function datePartOrder(page: Page): Promise<DatePart[]> {
  await page.evaluate(() => {
    const probe = document.createElement("input");
    probe.type = "date";
    probe.id = "date-probe";
    document.body.append(probe);
  });
  const probe = page.locator("#date-probe");
  await probe.focus();
  await page.keyboard.type("02032004");
  const value = await probe.inputValue();
  await page.evaluate(() => document.getElementById("date-probe")?.remove());
  if (value === "2004-02-03") return ["month", "day", "year"];
  if (value === "2004-03-02") return ["day", "month", "year"];
  return ["year", "month", "day"];
}

/** Type a whole date into the focused, empty date input, part by part. */
async function typeDate(page: Page, iso: string, order: readonly DatePart[]): Promise<void> {
  const [year = "", month = "", day = ""] = iso.split("-");
  const parts: Record<DatePart, string> = { year, month, day };
  for (const [index, part] of order.entries()) {
    await page.keyboard.type(parts[part]);
    // Months and days move on after two digits; a year waits for more.
    if (part === "year" && index < order.length - 1) await page.keyboard.press("ArrowRight");
  }
}

/** Focus a date input's year. */
async function focusYear(page: Page, field: Locator, order: readonly DatePart[]): Promise<void> {
  await field.focus();
  for (let i = 0; i < order.indexOf("year"); i++) await page.keyboard.press("ArrowRight");
}

test.describe("typing a due date", () => {
  let order: DatePart[];

  test.beforeEach(async ({ page }) => {
    await signIn(page, 1);
    order = await datePartOrder(page);
  });

  test("changing the year of a date saves the new date once, when the field is left", async ({ page }) => {
    const task = await newTask(page, { due_date: "2026-10-20" });
    const saves = watchSaves(page, task.id);
    await page.goto(`/list?item=task:${task.id}`);
    const field = panel(page).getByLabel("Due date");
    await expect(field).toHaveValue("2026-10-20");
    await focusYear(page, field, order);
    await page.keyboard.type("2027");
    await expect(field).toHaveValue("2027-10-20");
    expect(saves).toEqual([]);
    await panel(page).getByRole("heading", { name: "Task" }).click();
    await expect.poll(async () => (await current(page, task.id))?.due_date).toBe("2027-10-20");
    expect(saves).toEqual([{ body: JSON.stringify({ due_date: "2027-10-20" }), status: 200 }]);
    const dated = (await history(page, "task", task.id)).filter((e) => e.action === "update" && e.after && "due_date" in e.after);
    expect(dated.map((e) => e.after?.due_date)).toEqual(["2027-10-20"]);
  });

  test("a date typed into an empty field is saved on Enter", async ({ page }) => {
    const task = await newTask(page);
    const saves = watchSaves(page, task.id);
    await page.goto(`/list?item=task:${task.id}`);
    const field = panel(page).getByLabel("Due date");
    await field.focus();
    await typeDate(page, "2027-11-15", order);
    await expect(field).toHaveValue("2027-11-15");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await current(page, task.id))?.due_date).toBe("2027-11-15");
    expect(saves).toEqual([{ body: JSON.stringify({ due_date: "2027-11-15" }), status: 200 }]);
  });

  test("a half-typed date is not saved and does not clear the saved one", async ({ page }) => {
    const task = await newTask(page, { due_date: "2026-10-20" });
    const saves = watchSaves(page, task.id);
    await page.goto(`/list?item=task:${task.id}`);
    const field = panel(page).getByLabel("Due date");
    await focusYear(page, field, order);
    await page.keyboard.type("20");
    await panel(page).getByRole("heading", { name: "Task" }).click();
    await expect(panel(page).getByRole("alert")).toContainText("year");
    expect(saves).toEqual([]);
    expect((await current(page, task.id))?.due_date).toBe("2026-10-20");
    // Clear still clears.
    await panel(page).getByRole("button", { name: "Clear" }).click();
    await expect.poll(async () => (await current(page, task.id))?.due_date).toBeNull();
  });
});

test("Back on a phone saves what was typed before the panel closes", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, 1, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const task = await newTask(page);
  await page.goto("/list");
  await page.getByRole("tab", { name: /^Unassigned/ }).click();
  await page.getByRole("button", { name: task.title }).click();
  await expect(panel(page).getByRole("heading", { name: "Task" })).toBeVisible();
  const text = "Typed on the phone, then Back";
  await panel(page).getByLabel("Details").fill(text);
  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => (await current(page, task.id))?.detail).toBe(text);
  await context.close();
});

test.describe("closing the panel", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 1);
  });

  test("returns focus to the list row that opened it", async ({ page }) => {
    const task = await newTask(page, { assignee_id: "00000000000000000000000001" });
    await page.goto("/list");
    const opener = page.getByRole("button", { name: task.title });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("heading", { name: "Task" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("returns focus to the card that opened it on the board", async ({ page }) => {
    const task = await newTask(page, { x: 40, y: 40 });
    await page.goto("/board");
    const card = page.locator(`.react-flow__node[data-id="task:${task.id}"]`);
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("heading", { name: "Task" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(card).toBeFocused();
  });
});
