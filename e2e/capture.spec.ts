// The capture sheet: recording, uploads and quick text, and keeping a
// recording when its upload fails.

import { expect, test } from "@playwright/test";
import { signIn, signedInPage, unique } from "./helpers";

/** The record button that opens the sheet (desktop header). */
function recordButton(page: Parameters<typeof signIn>[0]) {
  return page.getByRole("button", { name: "Record" }).first();
}

test("record about two seconds, stop and save, and see the transcript", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  const timer = page.locator(".record-timer");
  await expect(timer).toBeVisible();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Stop and save" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible({ timeout: 30_000 });

  await page.goto("/inbox");
  const card = page.locator(".capture-card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Mock transcript", { timeout: 30_000 });
});

test("edit a transcript and keep it after a reload", async ({ page }) => {
  await signIn(page, 1);
  // Make a capture to edit.
  await page.goto("/board");
  await recordButton(page).click();
  await page.getByRole("button", { name: "Quick text" }).click();
  const text = unique("transcript to edit");
  await page.getByPlaceholder("Type a note…").fill(text);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible();

  await page.goto("/inbox");
  // Wait for the card under its original text, then switch to a locator that
  // survives the edit: each card carries its capture id.
  const original = page.locator(".capture-card").filter({ hasText: text });
  await expect(original).toBeVisible();
  const captureId = await original.getAttribute("data-capture-id");
  expect(captureId).toBeTruthy();
  const card = page.locator(`.capture-card[data-capture-id="${captureId}"]`);
  const edited = `Edited transcript ${Date.now().toString(36)}`;
  const area = card.locator("textarea");
  await area.fill(edited);
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/api/captures"),
  );
  await card.getByRole("button", { name: "Save" }).click();
  await saved;
  await expect(area).toHaveValue(edited);
  await page.reload();
  await expect(
    page.locator(`.capture-card[data-capture-id="${captureId}"] textarea`),
  ).toHaveValue(edited, { timeout: 10_000 });
});

test("upload a small WAV built in code", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  // A valid 44-byte RIFF/WAVE header followed by a little silence.
  const wav = buildWav();
  await page.locator('.capture-upload input[type="file"]').setInputFiles({
    name: "tiny.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await expect(page.getByText("tiny.wav")).toBeVisible();
  await page.getByRole("button", { name: "Upload to Inbox" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible({ timeout: 30_000 });

  await page.goto("/inbox");
  await expect(page.locator(".capture-card").first()).toBeVisible();
});

test("quick text capture", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  await page.getByRole("button", { name: "Quick text" }).click();
  const text = unique("quick text capture");
  await page.getByPlaceholder("Type a note…").fill(text);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible();

  await page.goto("/inbox");
  await expect(page.locator(".capture-card").filter({ hasText: text })).toBeVisible();
});

test("ignore a capture and put it back in the inbox", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  await page.getByRole("button", { name: "Quick text" }).click();
  const text = unique("ignore me");
  await page.getByPlaceholder("Type a note…").fill(text);
  await page.getByRole("button", { name: "Save" }).click();

  await page.goto("/inbox");
  const card = page.locator(".capture-card").filter({ hasText: text });
  await card.getByRole("button", { name: "Ignore" }).click();
  await page.getByRole("button", { name: "Ignored" }).click();
  const ignored = page.locator(".capture-card").filter({ hasText: text });
  await expect(ignored).toBeVisible();
  await ignored.getByRole("button", { name: "Back to inbox" }).click();
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.locator(".capture-card").filter({ hasText: text })).toBeVisible();
});

test("the audio element's request answers 200 or 206", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop and save" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible({ timeout: 30_000 });

  await page.goto("/inbox");
  const audio = page.locator(".capture-card audio").first();
  await expect(audio).toBeVisible({ timeout: 30_000 });
  const src = await audio.getAttribute("src");
  expect(src).toBeTruthy();
  const response = await page.request.get(src ?? "");
  expect([200, 206]).toContain(response.status());
});

test("a phone's bottom-bar Record button starts recording in one tap", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, 1, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await page.goto("/board");
  await expect(page.locator(".record-button--bar")).toBeVisible();
  await page.locator(".record-button--bar").click();
  await expect(page.getByRole("button", { name: "Stop and save" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await context.close();
});

test("a failed upload keeps the recording and Try again succeeds", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/board");
  await recordButton(page).click();
  await page.waitForTimeout(1500);

  // The first upload attempt answers 500.
  let failed = false;
  await page.route("**/api/captures", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "boom", message: "Something went wrong." } }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Stop and save" }).click();
  await expect(page.getByText("Try again")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Saved to the Inbox")).toBeVisible({ timeout: 30_000 });
});

/** A minimal mono 8 kHz 8-bit WAV: a 44-byte header and one second of silence. */
function buildWav(): Buffer {
  const samples = 8000;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}
