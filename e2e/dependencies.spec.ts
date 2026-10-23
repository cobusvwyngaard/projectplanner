// Task dependencies in the app: drawing one task to another makes the source
// come first, the board shows a dependency arrow and waiting text, the panel
// groups and reverses dependencies, and a circle of waiting tasks is refused.

import { expect, test, type Page } from "@playwright/test";
import type { MutationResponse } from "../src/shared/api";
import type { Link, TaskView } from "../src/shared/types";
import { linkRelation } from "../src/app/lib/dependencies";
import { api, bootstrap, signIn, unique } from "./helpers";

const panel = (page: Page) => page.locator(".panel");
const card = (page: Page, task: TaskView) => page.locator(`.react-flow__node[data-id="task:${task.id}"]`);

async function newTask(page: Page, x: number, y: number): Promise<TaskView> {
  return (await api<MutationResponse<TaskView>>(page, "POST", "/api/tasks", { title: unique("Task"), x, y })).row;
}

async function depend(page: Page, before: TaskView, after: TaskView): Promise<Link> {
  const body = {
    depends: {
      before: { type: "task", id: before.id },
      after: { type: "task", id: after.id },
    },
  };
  return (await api<MutationResponse<Link>>(page, "POST", "/api/links", body)).row;
}

async function dependencyExists(page: Page, before: TaskView, after: TaskView): Promise<boolean> {
  const { links } = await bootstrap(page);
  return links.some((link) => {
    const relation = linkRelation(link);
    return relation !== "related" && relation.before.id === before.id && relation.after.id === after.id;
  });
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 1);
});

test("drawing from one task to another makes the target wait for the source", async ({ page }) => {
  const [first, second] = [await newTask(page, 80, 140), await newTask(page, 520, 140)];
  await page.goto("/board");
  const from = card(page, first).locator(".react-flow__handle.source");
  const to = card(page, second).locator(".react-flow__handle.target");
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("The handles are not on screen.");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => dependencyExists(page, first, second)).toBe(true);
  const { links } = await bootstrap(page);
  const dependency = links.find((link) => linkRelation(link) !== "related");
  if (!dependency) throw new Error("The dependency was not saved.");
  const edge = page.locator(`.react-flow__edge[data-testid="rf__edge-link:${dependency.id}"]`);
  await expect(edge).toHaveAttribute("aria-label", "Dependency");
  const line = edge.locator(".link-edge--dependency");
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("marker-end", /-arrow/);
  await expect(card(page, second).locator(".task-waiting")).toHaveText(`Waiting for "${first.title}"`);
  await expect(card(page, first).locator(".task-waiting")).toHaveCount(0);
});

test("the panel groups a task's dependencies and reverses one", async ({ page }) => {
  const [first, second] = [await newTask(page, 80, 140), await newTask(page, 520, 140)];
  await depend(page, first, second);
  await page.goto(`/board?item=task:${second.id}`);
  await expect(panel(page).getByRole("heading", { name: "Task" })).toBeVisible();
  await expect(panel(page).getByRole("heading", { name: "Waits for" })).toBeVisible();
  const waiting = panel(page).locator(".linked-list").filter({ hasText: first.title });
  await expect(waiting).toContainText(first.title);
  await expect(waiting.getByRole("button", { name: "Reverse" })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Make related" })).toBeVisible();
  await waiting.getByRole("button", { name: "Reverse" }).click();
  await expect.poll(() => dependencyExists(page, second, first)).toBe(true);
  await expect(card(page, first).locator(".task-waiting")).toHaveText(`Waiting for "${second.title}"`);
});

test("ticking off a waiting task warns about its open prerequisite but still ticks it off", async ({ page }) => {
  const [first, second] = [await newTask(page, 80, 140), await newTask(page, 520, 140)];
  await depend(page, first, second);
  await page.goto("/board");
  await card(page, second).getByRole("checkbox", { name: `Tick off “${second.title}”` }).click();
  const toast = page.locator(".toast").filter({ hasText: "Waits for" });
  await expect(toast).toContainText(`Done. Waits for "${first.title}", which is not done yet.`);
  await expect(card(page, second).getByRole("checkbox", { name: `Reopen “${second.title}”` })).toBeChecked();
});

test("a dependency that would make a circle is refused in words", async ({ page }) => {
  const [first, second, third] = [await newTask(page, 80, 140), await newTask(page, 420, 140), await newTask(page, 760, 140)];
  await depend(page, first, second);
  await depend(page, second, third);
  const before = (await bootstrap(page)).links.length;
  await page.goto(`/board?item=task:${first.id}`);
  await expect(panel(page).getByRole("heading", { name: "Task" })).toBeVisible();
  await panel(page).getByRole("button", { name: "Link to…" }).click();
  await panel(page).getByLabel("Search notes and tasks to link").fill(third.title);
  const choice = panel(page).locator(".picker-choice").filter({ hasText: third.title });
  await expect(choice).toBeVisible();
  await choice.getByRole("button", { name: "This task waits for it" }).click();
  await expect(page.locator(".toast--error")).toContainText("That would make a circle of tasks waiting for each other.");
  expect((await bootstrap(page)).links).toHaveLength(before);
});
