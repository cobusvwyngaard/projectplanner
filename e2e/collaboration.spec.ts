// SPEC 9, phase 1: both people create, assign, date, link and tick off items;
// the other browser sees the changes through polling with the right
// attribution; the Activity view and its filters show who did what; a change
// can be reverted from the item's history, with a confirmation when a later
// change touched the same field.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { addDays, localToday } from "../src/shared/dates";
import { formatDate } from "../src/shared/format";
import type { TaskView } from "../src/shared/types";
import { PERSON_2, api, bootstrap, names, signedInPage, unique } from "./helpers";

test.describe.configure({ timeout: 180_000 });

/** The item panel (drawer). */
const panel = (page: Page) => page.locator(".panel");

/** A history entry in the panel, by the text it contains. */
const historyEntry = (page: Page, text: string | RegExp) => panel(page).locator(".timeline .event").filter({ hasText: text });

async function taskByTitle(page: Page, title: string): Promise<TaskView> {
  const task = (await bootstrap(page)).tasks.find((t) => t.title === title);
  if (!task) throw new Error("The task is not on the board.");
  return task;
}

/** Type into a panel text field and leave it, which saves it. */
async function edit(field: Locator, text: string): Promise<void> {
  await field.fill(text);
  await field.blur();
}

test("two people plan together and every change is attributed", async ({ browser }) => {
  const one = await signedInPage(browser, 1);
  const two = await signedInPage(browser, 2);
  const p1 = one.page;
  const p2 = two.page;
  const who = await names(p1);
  const noteTitle = unique("Holiday ideas");
  const taskTitle = unique("Book the campsite");
  const due = addDays(localToday(), 1);

  // Person 2 is looking at the board before anything happens.
  await p2.goto("/board");
  await expect(p2.getByRole("button", { name: "Note", exact: true })).toBeVisible();

  await test.step("Person 1 creates a note", async () => {
    await p1.goto("/board");
    await p1.getByRole("button", { name: "Note", exact: true }).click();
    await expect(panel(p1).getByRole("heading", { name: "Note" })).toBeVisible();
    await edit(panel(p1).getByLabel("Title"), noteTitle);
    await edit(panel(p1).getByLabel("Text"), "Somewhere with a river and shade.");
    await expect(p1.locator(".react-flow__node-note").filter({ hasText: noteTitle })).toBeVisible();
  });

  await test.step("Person 1 creates a task, assigns it to Person 2, dates it and links it to the note", async () => {
    await p1.getByRole("button", { name: "Task", exact: true }).click();
    await p1.getByLabel("New task title").fill(taskTitle);
    await p1.getByLabel("New task title").press("Enter");
    await expect(panel(p1).getByRole("heading", { name: "Task" })).toBeVisible();
    await expect(panel(p1).getByLabel("Title")).toHaveValue(taskTitle);

    await panel(p1).getByRole("radio", { name: who.p2, exact: true }).check();
    await panel(p1).getByLabel("Due date").fill(due);
    await panel(p1).getByRole("button", { name: "Link to…" }).click();
    await panel(p1).getByLabel("Search notes and tasks to link").fill(noteTitle);
    await panel(p1).getByRole("button", { name: noteTitle }).click();
    await expect(panel(p1).locator(".linked-list")).toContainText(noteTitle);

    await expect.poll(async () => {
      const task = await taskByTitle(p1, taskTitle);
      return [task.assignee_id, task.due_date];
    }).toEqual([PERSON_2, due]);
    // The link is drawn on the board.
    await expect(p1.locator(".react-flow__edge")).not.toHaveCount(0);
  });

  await test.step("Person 1 ticks the task off on the board", async () => {
    await p1.keyboard.press("Escape");
    await expect(panel(p1)).toHaveCount(0);
    await p1.getByRole("checkbox", { name: `Tick off “${taskTitle}”` }).check();
    await expect(p1.getByRole("checkbox", { name: `Reopen “${taskTitle}”` })).toBeChecked();
  });

  await test.step("Person 2 sees it all arrive through polling, attributed to Person 1", async () => {
    const card = p2.locator(".react-flow__node-task").filter({ hasText: taskTitle });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("checkbox")).toBeChecked();
    await expect(card.locator(".provenance")).toContainText(who.p1);
    await expect(card.locator(".initials")).toHaveAttribute("title", `Assigned to ${who.p2}`);
    await expect(card.locator(".due-chip")).toHaveText("Tomorrow");
    await expect(p2.locator(".react-flow__node-note").filter({ hasText: noteTitle })).toBeVisible();

    // Open it from the list (Done tab) and read the history.
    await p2.getByRole("link", { name: "List" }).click();
    await p2.getByRole("tab", { name: /^Done/ }).click();
    await p2.locator(".row").filter({ hasText: taskTitle }).getByRole("button").click();
    await expect(panel(p2).locator(".provenance--detailed")).toContainText(`Created by${who.p1}`);
    await expect(historyEntry(p2, `${who.p1} created this task`)).toBeVisible();
    await expect(historyEntry(p2, `${who.p1} ticked off this task`)).toBeVisible();
    await expect(historyEntry(p2, `${who.p1} changed this task`).filter({ hasText: `Assigned to: Nobody → ${who.p2}` })).toBeVisible();
    await expect(historyEntry(p2, `${who.p1} changed this task`).filter({ hasText: `Due date: No date → ${formatDate(due)}` })).toBeVisible();
    await expect(historyEntry(p2, `${who.p1} linked`)).toContainText(noteTitle);
  });

  const renamed = `${taskTitle} (river site)`;
  await test.step("Person 2 edits the task and Person 1 sees who changed it", async () => {
    const title = panel(p2).getByLabel("Title");
    await title.fill(renamed);
    await title.press("Enter");
    await expect(historyEntry(p2, `${who.p2} changed this task`).filter({ hasText: "Title:" })).toBeVisible();

    const card = p1.locator(".react-flow__node-task").filter({ hasText: renamed });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".provenance")).toContainText(`changed by ${who.p2}`);
  });

  await test.step("the Activity view attributes every change, and its filters work", async () => {
    await p1.getByRole("link", { name: "Activity" }).click();
    const rows = p1.locator(".feed .event");
    const edited = rows.filter({ hasText: `${who.p2} changed the task` }).filter({ hasText: renamed });
    const created = rows.filter({ hasText: `${who.p1} created the task` }).filter({ hasText: taskTitle });
    const ticked = rows.filter({ hasText: `${who.p1} ticked off the task` });
    await expect(edited).toBeVisible();
    await expect(created).toBeVisible();
    await expect(ticked.first()).toBeVisible();

    await p1.getByRole("button", { name: "Humans only" }).click();
    await expect(p1.getByRole("button", { name: "Humans only" })).toHaveAttribute("aria-pressed", "true");
    await expect(edited).toBeVisible();
    await expect(created).toBeVisible();

    await p1.getByLabel("Person", { exact: true }).selectOption({ label: who.p2 });
    await expect(edited).toBeVisible();
    await expect(created).toHaveCount(0);
    const actors = await rows.locator(".event-sentence > .badge").allTextContents();
    expect(actors.length).toBeGreaterThan(0);
    expect(new Set(actors)).toEqual(new Set([who.p2]));

    await p1.getByLabel("Person", { exact: true }).selectOption({ label: who.p1 });
    await expect(created).toBeVisible();
    await expect(edited).toHaveCount(0);

    await p1.getByRole("button", { name: "Clear filters" }).click();
    await expect(edited).toBeVisible();
  });

  await test.step("one change is reverted from the item's history", async () => {
    await p1.locator(".feed .event").filter({ hasText: `${who.p2} changed the task` }).getByRole("button", { name: renamed }).first().click();
    await expect(panel(p1).getByLabel("Title")).toHaveValue(renamed);
    await historyEntry(p1, `${who.p2} changed this task`).filter({ hasText: "Title:" }).getByRole("button", { name: "Revert" }).click();
    await expect(p1.locator(".toast").last()).toContainText("Reverted 1 change.");
    await expect(panel(p1).getByLabel("Title")).toHaveValue(taskTitle);
    await expect(historyEntry(p1, `${who.p1} reverted a change to this task`)).toBeVisible();
    await expect.poll(async () => (await taskByTitle(p1, taskTitle)).title).toBe(taskTitle);
  });

  await test.step("reverting a change that was changed again asks first", async () => {
    await edit(panel(p1).getByLabel("Details"), "Bring the big tent.");
    const first = historyEntry(p1, `${who.p1} changed this task`).filter({ hasText: /\(empty\)\s*→\s*Bring the big tent\./ });
    await expect(first).toBeVisible();

    // Person 2 changes the same field afterwards.
    const task = await taskByTitle(p1, taskTitle);
    await api(p2, "PATCH", `/api/tasks/${task.id}`, { detail: "Bring both tents." });
    await expect(panel(p1).getByLabel("Details")).toHaveValue("Bring both tents.", { timeout: 20_000 });

    await first.getByRole("button", { name: "Revert" }).click();
    const conflict = first.locator(".conflict");
    await expect(conflict).toContainText("Later changes touched the same fields.");
    await expect(conflict).toContainText(`${who.p2} changed the task`);
    await expect(conflict).toContainText("(Details)");
    await conflict.getByRole("button", { name: "Revert anyway" }).click();
    await expect(p1.locator(".toast").last()).toContainText("Reverted 1 change.");
    await expect(panel(p1).getByLabel("Details")).toHaveValue("");
    await expect.poll(async () => (await taskByTitle(p1, taskTitle)).detail).toBe("");
  });

  await one.context.close();
  await two.context.close();
});
