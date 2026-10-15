// SPEC 8: the List view's tabs, inline tick-off and quick-add, and the list
// as the default view on a phone.

import { expect, test } from "@playwright/test";
import type { MutationResponse } from "../src/shared/api";
import { addDays, localToday } from "../src/shared/dates";
import type { TaskView } from "../src/shared/types";
import { PERSON_1, PERSON_2, api, bootstrap, names, signIn, signedInPage, unique } from "./helpers";

test("list tabs show the right tasks and tick off inline", async ({ page }) => {
  await signIn(page, 1);
  const today = localToday();
  const create = async (title: string, extra: Record<string, unknown>) =>
    (await api<MutationResponse<TaskView>>(page, "POST", "/api/tasks", { title, ...extra })).row;
  const mine = await create(unique("Water the seedlings"), { assignee_id: PERSON_1, due_date: today });
  const theirs = await create(unique("Collect the parcel"), { assignee_id: PERSON_2, due_date: addDays(today, 30) });
  const overdue = await create(unique("Return the library books"), { assignee_id: PERSON_1, due_date: addDays(today, -3) });
  const nobody = await create(unique("Fix the gate latch"), { assignee_id: null });
  const done = await create(unique("Pay the plumber"), { assignee_id: PERSON_1 });
  await api(page, "POST", `/api/tasks/${done.id}/complete`);

  await page.goto("/list");
  const panel = page.getByRole("tabpanel");
  const row = (title: string) => panel.locator(".row").filter({ hasText: title });
  const tab = (name: RegExp) => page.getByRole("tab", { name });

  await tab(/^Mine/).click();
  await expect(row(mine.title)).toBeVisible();
  await expect(row(overdue.title)).toBeVisible();
  await expect(row(theirs.title)).toHaveCount(0);
  await expect(row(overdue.title).locator(".due-chip--overdue")).toBeVisible();
  await expect(row(mine.title).locator(".due-chip--today")).toHaveText("Today");

  await tab(/^Theirs/).click();
  await expect(row(theirs.title)).toBeVisible();
  await expect(row(mine.title)).toHaveCount(0);

  await tab(/^Overdue/).click();
  await expect(row(overdue.title)).toBeVisible();
  await expect(row(mine.title)).toHaveCount(0);

  await tab(/^This week/).click();
  await expect(row(mine.title)).toBeVisible();
  await expect(row(theirs.title)).toHaveCount(0);

  await tab(/^Unassigned/).click();
  await expect(row(nobody.title)).toBeVisible();

  await tab(/^Done/).click();
  await expect(row(done.title)).toBeVisible();

  // Tick off inline: the task leaves Mine and shows under Done.
  await tab(/^Mine/).click();
  // click(), not check(): the row leaves the tab as soon as the task is done.
  await row(mine.title).getByRole("checkbox", { name: `Tick off “${mine.title}”` }).click();
  await expect(row(mine.title)).toHaveCount(0);
  await tab(/^Done/).click();
  await expect(row(mine.title)).toBeVisible();
  await expect(row(mine.title).getByRole("checkbox")).toBeChecked();
  await expect.poll(async () => (await bootstrap(page)).tasks.find((t) => t.id === mine.id)?.status).toBe("done");

  // Quick-add in Theirs assigns the new task to the other person.
  const who = await names(page);
  await tab(/^Theirs/).click();
  const quick = unique("Phone the vet");
  await page.getByLabel(`Add a task for ${who.p2}`).fill(quick);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(row(quick)).toBeVisible();
  await expect(page.getByLabel(`Add a task for ${who.p2}`)).toHaveValue("");
  const added = (await bootstrap(page)).tasks.find((t) => t.title === quick);
  expect(added?.assignee_id).toBe(PERSON_2);
});

test("a phone opens the list by default, with a tab bar", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, 1, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/list$/);
  await expect(page.getByRole("tab", { name: /^Mine/ })).toBeVisible();
  await expect(page.locator(".tab-bar")).toBeVisible();
  await expect(page.locator(".top-nav")).toHaveCount(0);
  await context.close();
});

test("a wide screen opens the board by default", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/");
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.locator(".react-flow")).toBeVisible();
});
