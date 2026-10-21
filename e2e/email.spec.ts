// Email end to end (SPEC 11): a message cc'd to a registered address reaches
// the Inbox with its body and attachment, a message no registered address
// appears in is refused, and a redelivery of the same message changes nothing.
// A task that Claude makes from such a message is marked as coming from
// outside, and sits last in the tray. Wrangler's local email simulator
// delivers the raw message to the Worker's email() handler. Every address and
// text here is made up.

import { readFileSync } from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { CapturesResponse } from "../src/shared/api";
import type { Capture } from "../src/shared/types";
import { McpClient, PERSON_1, api, connectClaude, signIn, unique } from "./helpers";

/** Where `wrangler dev` accepts a message for the Worker's email() handler. */
const EMAIL_HANDLER = "/cdn-cgi/handler/email";

const PLANNER = "planner@example.com";
const OUTSIDER = "out@example.org";

const ATTACHMENT_NAME = "notes.txt";
const ATTACHMENT_TEXT = "The marquee is booked for the fourteenth.";
const BODY = "Please add the marquee to the weekend plans.";

interface RawMessage {
  from: string;
  to: string;
  cc: string;
  subject: string;
  /** The Message-ID header, which the simulator needs and the Worker dedupes on. */
  messageId: string;
}

/** One multipart message with a short plain-text body and one small text attachment. */
function rawMessage({ from, to, cc, subject, messageId }: RawMessage): string {
  const boundary = "planner-boundary";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Cc: ${cc}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    BODY,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"; name="${ATTACHMENT_NAME}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${ATTACHMENT_NAME}"`,
    "",
    Buffer.from(ATTACHMENT_TEXT, "utf8").toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Hand one raw message to the local simulator: 200 when accepted, 400 when refused. */
function deliver(page: Page, envelope: { from: string; to: string }, message: string): Promise<APIResponse> {
  const query = new URLSearchParams({ from: envelope.from, to: envelope.to });
  return page.request.post(`${EMAIL_HANDLER}?${query.toString()}`, {
    data: message,
    headers: { "Content-Type": "message/rfc822" },
  });
}

/** The stored capture with that subject, or null when none is stored. */
async function newCapture(page: Page, subject: string): Promise<Capture | null> {
  const response = await api<CapturesResponse>(page, "GET", "/api/captures?status=new&limit=30");
  return response.captures.find((row) => row.email_subject === subject) ?? null;
}

/** How far the Worker has read the capture with that subject, or null when none is stored. */
async function transcriptStatus(page: Page, subject: string): Promise<string | null> {
  return (await newCapture(page, subject))?.transcript_status ?? null;
}

test("an email cc'd to a registered address reaches the Inbox with its attachment", async ({ page }) => {
  await signIn(page, 1);

  // Settings › People: register an address for Person 1. The people are listed
  // with the signed-in person first, so the first field is Person 1's.
  const address = `${unique("person1").replace(/\s+/g, "-").toLowerCase()}@example.com`;
  await page.goto("/settings");
  const field = page.getByLabel("Add an email address").first();
  await field.fill(address);
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByText(address)).toBeVisible();

  // A stranger writes to the planner and cc's that address.
  const subject = unique("Notes for the weekend");
  const message = rawMessage({
    from: OUTSIDER,
    to: PLANNER,
    cc: address,
    subject,
    messageId: `<${unique("weekend").replace(/\s+/g, "-")}@example.org>`,
  });
  const accepted = await deliver(page, { from: OUTSIDER, to: PLANNER }, message);
  expect(accepted.status()).toBe(200);

  // The message is stored at once; its body arrives when the Worker reads it.
  await expect.poll(() => transcriptStatus(page, subject), { timeout: 30_000 }).toBe("done");
  await page.goto("/inbox");

  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: subject }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByText("Email", { exact: true })).toBeVisible();
  await expect(card.getByText("Sender not verified")).toBeVisible();
  // Person 1's chip sits in the Cc group, because that address maps to them.
  const ccGroup = card.getByRole("paragraph").filter({ hasText: "Cc" });
  await expect(ccGroup.getByText("Person 1", { exact: true })).toBeVisible();
  await expect(card.getByText(BODY, { exact: true })).toBeVisible();

  // The attachment is listed with its name, its type and its size in bytes...
  const size = Buffer.byteLength(ATTACHMENT_TEXT, "utf8");
  const attachment = card.getByRole("link", { name: `${ATTACHMENT_NAME} · TXT · ${size} B` });
  await expect(attachment).toBeVisible();
  // ...and it downloads as the text that was attached.
  const [download] = await Promise.all([page.waitForEvent("download"), attachment.click()]);
  expect(await download.suggestedFilename()).toBe(ATTACHMENT_NAME);
  expect(readFileSync(await download.path(), "utf8")).toBe(ATTACHMENT_TEXT);

  // A message with no registered address in From, To or Cc is refused.
  const refusedSubject = unique("Mail for nobody");
  const refused = await deliver(
    page,
    { from: OUTSIDER, to: "stranger@example.org" },
    rawMessage({
      from: OUTSIDER,
      to: "stranger@example.org",
      cc: "someone-else@example.org",
      subject: refusedSubject,
      messageId: `<${unique("refused").replace(/\s+/g, "-")}@example.org>`,
    }),
  );
  expect(refused.status()).toBe(400);
  await page.reload();
  await expect(card).toBeVisible();
  await expect(page.getByRole("heading", { name: refusedSubject })).toHaveCount(0);

  // The same Message-ID delivered again is dropped: still one card with it.
  const redelivered = await deliver(page, { from: OUTSIDER, to: PLANNER }, message);
  expect(redelivered.status()).toBe(200);
  await page.reload();
  await expect(card).toHaveCount(1);

  // Leave the addresses as they were found.
  await page.goto("/settings");
  const row = page.getByRole("listitem").filter({ hasText: address });
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("group", { name: `Remove ${address}?` }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(address)).toHaveCount(0);
});

test("a task made from an outside email is marked and sits last in the tray", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("The smoke tests need a baseURL.");

  await signIn(page, 1);

  // Settings › People: register an address for Person 1, so the message below
  // is accepted (SPEC 11.2) even though the sender is a stranger.
  const address = `${unique("person1").replace(/\s+/g, "-").toLowerCase()}@example.com`;
  await page.goto("/settings");
  const field = page.getByLabel("Add an email address").first();
  await field.fill(address);
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByText(address)).toBeVisible();

  // A stranger writes to the planner and cc's that address.
  const subject = unique("Marquee for the weekend");
  const message = rawMessage({
    from: OUTSIDER,
    to: PLANNER,
    cc: address,
    subject,
    messageId: `<${unique("marquee").replace(/\s+/g, "-")}@example.org>`,
  });
  expect((await deliver(page, { from: OUTSIDER, to: PLANNER }, message)).status()).toBe(200);
  await expect.poll(() => transcriptStatus(page, subject), { timeout: 30_000 }).toBe("done");

  const capture = await newCapture(page, subject);
  if (!capture) throw new Error("The email did not become a capture.");

  // Claude turns the email into two tasks, as it would after start_run: one
  // from the email and one from nothing. The outside title sorts before the
  // other, so only the flag can put it last.
  const token = await connectClaude(page, baseURL, unique("Claude Desktop"));
  const mcp = new McpClient(baseURL, token.accessToken);
  await mcp.start();
  const started = await mcp.callTool<{ run_id: string }>("start_run", {
    intent: unique("Plan the weekend from the email"),
    capture_ids: [capture.id],
  });
  expect(started.isError).toBe(false);
  const runId = started.json?.run_id;
  if (!runId) throw new Error("start_run did not return a run id.");

  const outsideTitle = unique("Aardvark reply about the marquee");
  const outside = await mcp.callTool<{ id: string }>("create_task", {
    run_id: runId,
    title: outsideTitle,
    assignee_id: PERSON_1,
    source_capture_ids: [capture.id],
  });
  expect(outside.isError).toBe(false);

  const normalTitle = unique("Zebra sort the boxes");
  const normal = await mcp.callTool<{ id: string }>("create_task", {
    run_id: runId,
    title: normalTitle,
    assignee_id: PERSON_1,
    source_capture_ids: [],
  });
  expect(normal.isError).toBe(false);

  const finished = await mcp.callTool("finish_run", { run_id: runId, summary: unique("Made two tasks from the email.") });
  expect(finished.isError).toBe(false);

  // Board: both tasks are in the tray; the outside one is last, in red, with
  // the words that say why.
  await page.goto("/board");
  const trayItem = page.locator(".tray-item").filter({ hasText: outsideTitle });
  await expect(trayItem).toBeVisible();
  const note = trayItem.locator(".from-outside");
  await expect(note).toHaveText("From an unregistered email address");
  await expect(note).toHaveCSS("color", "rgb(138, 34, 22)");

  const titles = await page.locator(".tray-item .tray-title").allInnerTexts();
  expect(titles).toContain(normalTitle);
  expect(titles.indexOf(outsideTitle)).toBeGreaterThan(titles.indexOf(normalTitle));
  expect(titles.at(-1)).toBe(outsideTitle);
  // The ordinary task carries no note.
  await expect(page.locator(".tray-item").filter({ hasText: normalTitle }).locator(".from-outside")).toHaveCount(0);

  // The mark is readable in the dark theme too.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(note).toHaveCSS("color", "rgb(245, 184, 174)");
  await page.emulateMedia({ colorScheme: "light" });

  // List view: the same words on the row, and none on the ordinary task.
  await page.goto("/list");
  const row = page.locator(".row").filter({ hasText: outsideTitle });
  await expect(row.getByText("From an unregistered email address")).toBeVisible();
  await expect(page.locator(".row").filter({ hasText: normalTitle }).locator(".from-outside")).toHaveCount(0);

  // Leave the address as it was found.
  await page.goto("/settings");
  const emailRow = page.getByRole("listitem").filter({ hasText: address });
  await emailRow.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("group", { name: `Remove ${address}?` }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(address)).toHaveCount(0);
});
