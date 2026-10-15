// SPEC 8: dragging a card saves its position once, when the drag ends (one
// event per drag, never per pixel); resizing a note likewise; a task from the
// tray is placed by dragging it onto the board.

import { expect, test, type Page } from "@playwright/test";
import type { MutationResponse } from "../src/shared/api";
import type { NoteView, TaskView } from "../src/shared/types";
import { api, freeBoardPoint, history, moves, signIn, unique } from "./helpers";

/** Double-click the empty board to make a note there, give it a title and close the panel. */
async function noteOnFreeSpot(page: Page, title: string): Promise<NoteView> {
  const spot = await freeBoardPoint(page);
  await page.mouse.dblclick(spot.x, spot.y);
  const panel = page.locator(".panel");
  await expect(panel.getByRole("heading", { name: "Note" })).toBeVisible();
  await panel.getByLabel("Title").fill(title);
  await panel.getByLabel("Title").press("Enter");
  await expect(page.locator(".react-flow__node-note").filter({ hasText: title })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  const { notes } = await api<{ notes: NoteView[] }>(page, "GET", "/api/bootstrap");
  const note = notes.find((n) => n.title === title);
  if (!note) throw new Error("The note was not saved.");
  return note;
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await expect(page.locator(".react-flow__pane")).toBeVisible();
});

test("dragging a note records exactly one move", async ({ page }) => {
  const note = await noteOnFreeSpot(page, unique("Drag me"));
  const card = page.locator(`.react-flow__node[data-id="note:${note.id}"]`);
  const box = await card.boundingBox();
  if (!box) throw new Error("The note is not on screen.");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith(`/api/notes/${note.id}`)) saves.push(request.postData() ?? "");
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 25; step++) await page.mouse.move(start.x + step * 6, start.y + step * 3);
  await page.mouse.up();

  await expect.poll(async () => moves(await history(page, "note", note.id)).length).toBe(1);
  const [move] = moves(await history(page, "note", note.id));
  expect(move?.before).toEqual({ x: note.x, y: note.y });
  const after = move?.after as { x: number; y: number };
  expect(after.x).toBeGreaterThan(note.x);
  expect(after.y).toBeGreaterThan(note.y);

  // The item's history in the app shows the one move.
  await card.click();
  const moved = page.locator(".panel .timeline .event").filter({ hasText: "moved this note" });
  await expect(moved).toHaveCount(1);
  await expect(moved).toContainText(`Position: ${note.x}, ${note.y} → ${after.x}, ${after.y}`);
  // One request for the whole drag, not one per mouse movement.
  expect(saves).toEqual([JSON.stringify(after)]);
});

test("resizing a note records exactly one change of size", async ({ page }) => {
  const note = await noteOnFreeSpot(page, unique("Resize me"));
  const card = page.locator(`.react-flow__node[data-id="note:${note.id}"]`);
  // Select it without opening the panel twice: click, then close the panel.
  await card.click();
  await page.keyboard.press("Escape");
  const handle = card.locator(".react-flow__resize-control.handle.bottom.right");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("No resize handle.");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(start.x + step * 6, start.y + step * 4);
  await page.mouse.up();

  await expect
    .poll(async () => (await history(page, "note", note.id)).filter((e) => e.action === "update" && e.after && "w" in e.after))
    .toHaveLength(1);
  expect(moves(await history(page, "note", note.id))).toHaveLength(0);
});

test("a task in the tray is placed by dragging it onto the board", async ({ page }) => {
  const title = unique("Sharpen the shears");
  const task = (await api<MutationResponse<TaskView>>(page, "POST", "/api/tasks", { title })).row;
  expect(task.x).toBeNull();
  const item = page.locator(".tray-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  const spot = await freeBoardPoint(page);
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("No board.");
  await item.dragTo(pane, { targetPosition: { x: spot.x - paneBox.x, y: spot.y - paneBox.y } });

  await expect(page.locator(".react-flow__node-task").filter({ hasText: title })).toBeVisible();
  await expect(item).toHaveCount(0);
  const placed = (await history(page, "task", task.id)).filter((e) => e.action === "update");
  expect(placed).toHaveLength(1);
  expect(placed[0]?.before).toEqual({ x: null, y: null });
});
