// The Claude connector end to end: a real OAuth connection from a tool on this
// device, a run that turns a capture into a note and a task, the app showing
// the run and its provenance, reverting the whole run, then disconnecting the
// connection from Settings and finding the old token refused.

import { expect, test } from "@playwright/test";
import { McpClient, PERSON_1, connectClaude, mcpToolStatus, names, signIn, unique } from "./helpers";

test("a Claude connection runs, is reverted and is disconnected", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("The smoke tests need a baseURL.");

  await signIn(page, 1);
  const who = await names(page);
  const clientName = unique("Claude Desktop");
  const captureText = unique("Spring clean the garage");
  const intent = unique("Plan the spring clean");
  const summary = unique("Made a note and a task for the garage.");
  const noteTitle = unique("Garage ideas");
  const taskTitle = unique("Clear the garage");

  // The capture the run will work from, made through the app's own API.
  const created = await page.request.fetch("/api/captures", {
    method: "POST",
    multipart: { kind: "text", text: captureText },
  });
  if (!created.ok()) throw new Error(`Creating the capture answered ${created.status()}`);
  const captureId = ((await created.json()) as { row: { id: string } }).row.id;

  const token = await connectClaude(page, baseURL, clientName);

  const mcp = new McpClient(baseURL, token.accessToken);
  await mcp.start();

  const inbox = await mcp.callTool<{ items: { id: string }[] }>("get_inbox", { limit: 20 });
  expect(inbox.isError).toBe(false);
  expect(inbox.json?.items?.some((item) => item.id === captureId)).toBe(true);

  const started = await mcp.callTool<{ run_id: string }>("start_run", { intent, capture_ids: [captureId] });
  expect(started.isError).toBe(false);
  const runId = started.json?.run_id;
  expect(runId).toBeTruthy();

  const note = await mcp.callTool<{ id: string }>("create_note", {
    run_id: runId,
    title: noteTitle,
    body: "Sort the shelves first, then the boxes.",
    source_capture_ids: [captureId],
  });
  expect(note.isError).toBe(false);
  expect(note.json?.id).toBeTruthy();

  const task = await mcp.callTool<{ id: string }>("create_task", {
    run_id: runId,
    title: taskTitle,
    detail: "Take the boxes to the dump.",
    assignee_id: PERSON_1,
    source_capture_ids: [captureId],
    link_to: [{ type: "note", id: note.json?.id }],
  });
  expect(task.isError).toBe(false);
  expect(task.json?.id).toBeTruthy();

  const marked = await mcp.callTool<{ marked: string[] }>("mark_captures", {
    run_id: runId,
    capture_ids: [captureId],
    status: "processed",
    note: "Turned into a note and a task.",
    source_capture_ids: [captureId],
  });
  expect(marked.json?.marked).toEqual([captureId]);

  const finished = await mcp.callTool<{ released: string[] }>("finish_run", { run_id: runId, summary });
  expect(finished.isError).toBe(false);

  await test.step("the processed capture points at its run", async () => {
    await page.goto("/inbox");
    await page.getByRole("button", { name: "Processed", exact: true }).click();
    const card = page.locator(`.capture-card[data-capture-id="${captureId}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator(".badge--claude")).toHaveText(`Claude (via ${who.p1})`);

    await card.getByRole("button", { name: "View in Activity" }).click();
    await expect(page).toHaveURL(/\/activity\?run=/);
    await expect(page.locator(".filter-chip")).toContainText(intent);
  });

  await test.step("the run shows in Activity with its intent and summary", async () => {
    await page.getByRole("tab", { name: "Claude runs" }).click();
    const runCard = page.locator(".run-card").filter({ hasText: intent });
    await expect(runCard.getByRole("heading", { name: intent })).toBeVisible();
    await expect(runCard).toContainText(summary);
  });

  await test.step("the task and the note carry Claude's provenance in the list", async () => {
    await page.getByRole("link", { name: "List" }).click();
    await page.getByRole("tab", { name: /^Mine/ }).click();
    const taskRow = page.locator(".row").filter({ hasText: taskTitle });
    await expect(taskRow).toBeVisible();
    await expect(taskRow.locator(".badge--claude")).toHaveText(`Claude (via ${who.p1})`);

    await page.getByRole("tab", { name: /^Notes/ }).click();
    const noteRow = page.locator(".row").filter({ hasText: noteTitle });
    await expect(noteRow).toBeVisible();
    await expect(noteRow.locator(".badge--claude")).toHaveText(`Claude (via ${who.p1})`);
  });

  await test.step("reverting the whole run removes both from the list", async () => {
    await page.getByRole("link", { name: "Activity" }).click();
    await page.getByRole("tab", { name: "Claude runs" }).click();
    const runCard = page.locator(".run-card").filter({ hasText: intent });
    await runCard.getByRole("button", { name: "Revert whole run" }).click();
    await expect(page.locator(".toast").last()).toContainText(/Reverted \d+ changes?\./);

    await page.getByRole("link", { name: "List" }).click();
    await page.getByRole("tab", { name: /^Mine/ }).click();
    await expect(page.locator(".row").filter({ hasText: taskTitle })).toHaveCount(0);
    await page.getByRole("tab", { name: /^Notes/ }).click();
    await expect(page.locator(".row").filter({ hasText: noteTitle })).toHaveCount(0);
  });

  await test.step("Settings lists the connection and disconnecting ends it", async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Claude connections" })).toBeVisible();
    const connection = page.locator(".session-row").filter({ hasText: clientName });
    await expect(connection).toContainText(who.p1);
    await expect(connection).toContainText(/Connected \d/);

    await connection.getByRole("button", { name: "Disconnect" }).click();
    await expect(connection.locator(".confirm")).toContainText(clientName);
    await connection.locator(".confirm").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.locator(".session-row").filter({ hasText: clientName })).toHaveCount(0);

    // The connection's old token is refused now.
    expect(await mcpToolStatus(baseURL, token.accessToken, "get_inbox", { limit: 5 })).toBe(401);
  });
});
