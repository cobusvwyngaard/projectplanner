// Email end to end (SPEC 11): a message cc'd to a registered address reaches
// the Inbox with its body and attachment, a message no registered address
// appears in is refused, and a redelivery of the same message changes nothing.
// Wrangler's local email simulator delivers the raw message to the Worker's
// email() handler. Every address and text here is made up.

import { readFileSync } from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { CapturesResponse } from "../src/shared/api";
import { api, signIn, unique } from "./helpers";

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

/** How far the Worker has read the capture with that subject, or null when none is stored. */
async function transcriptStatus(page: Page, subject: string): Promise<string | null> {
  const response = await api<CapturesResponse>(page, "GET", "/api/captures?status=new&limit=30");
  const capture = response.captures.find((row) => row.email_subject === subject);
  return capture?.transcript_status ?? null;
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
