// SPEC 8, Settings: labels (create, rename, recolour, reorder), people's names,
// keyterm prompting, and signing this browser out.

import { expect, test } from "@playwright/test";
import type { Label } from "../src/shared/types";
import { PERSON_2, api, bootstrap, signIn, signedInPage, unique } from "./helpers";

async function activeLabels(page: Parameters<typeof bootstrap>[0]): Promise<Label[]> {
  return (await bootstrap(page)).labels.filter((l) => l.archived_at === null).sort((a, b) => a.sort_order - b.sort_order);
}

test("labels can be created, renamed, recoloured and reordered", async ({ page }) => {
  await signIn(page, 1);
  // Another label first, so the new one has a label above it to swap with.
  await api(page, "POST", "/api/labels", { name: unique("Errands"), colour_hex: "#93c5fd" });
  await page.goto("/settings");

  const name = unique("Garden");
  const form = page.locator("form.new-label");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Hex colour").fill("#2F855A");
  await expect(form.locator(".label-preview .label-chip")).toHaveText(name);
  await expect(form.locator(".label-preview .label-chip")).toHaveCSS("background-color", "rgb(47, 133, 90)");
  await form.getByRole("button", { name: "Create label" }).click();
  await expect(form.getByLabel("Name")).toHaveValue("");

  const nameField = page.getByLabel(`Name of the label ${name}`);
  await expect(nameField).toHaveValue(name);
  let label = (await activeLabels(page)).find((l) => l.name === name);
  expect(label?.colour_hex).toBe("#2f855a");

  // Rename
  const renamed = `${name} beds`;
  await nameField.fill(renamed);
  await nameField.press("Enter");
  await expect(page.getByLabel(`Name of the label ${renamed}`)).toHaveValue(renamed);
  await expect.poll(async () => (await activeLabels(page)).some((l) => l.name === renamed)).toBe(true);

  // Recolour with a preset
  await page.getByRole("button", { name: `Recolour ${renamed}` }).click();
  const recolour = page.locator(".recolour");
  await recolour.getByRole("radio", { name: "Mint" }).check();
  await expect(recolour.locator(".label-preview .label-chip")).toHaveCSS("background-color", "rgb(134, 239, 172)");
  await recolour.getByRole("button", { name: "Save colour" }).click();
  await expect(recolour).toHaveCount(0);
  await expect.poll(async () => (await activeLabels(page)).find((l) => l.name === renamed)?.colour_hex).toBe("#86efac");

  // Reorder: move it up one place
  const before = (await activeLabels(page)).map((l) => l.id);
  label = (await activeLabels(page)).find((l) => l.name === renamed);
  const index = before.indexOf(label?.id ?? "");
  expect(index).toBeGreaterThan(0);
  await page.getByRole("button", { name: `Move ${renamed} up` }).click();
  const expected = [...before];
  expected.splice(index, 1);
  expected.splice(index - 1, 0, label?.id ?? "");
  await expect.poll(async () => (await activeLabels(page)).map((l) => l.id)).toEqual(expected);
  const rows = page.locator(".label-list").first().locator(".label-name");
  await expect(rows.nth(index - 1)).toHaveValue(renamed);
});

test("a person can be renamed", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/settings");
  const original = (await bootstrap(page)).users.find((u) => u.id === PERSON_2);
  if (!original) throw new Error("Person 2 is missing.");
  const form = page.locator("form.person").filter({ has: page.getByRole("heading", { name: original.display_name }) });
  const newName = unique("Thandi");
  await form.getByLabel("Display name").fill(newName);
  await form.getByLabel("Initials").fill("tm");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("form.person").getByRole("heading", { name: newName })).toBeVisible();
  await expect
    .poll(async () => (await bootstrap(page)).users.find((u) => u.id === PERSON_2))
    .toMatchObject({ display_name: newName, initials: "TM" });

  // Put the name back for anyone reading the board later.
  await api(page, "PATCH", `/api/users/${PERSON_2}`, { display_name: original.display_name, initials: original.initials });
});

test("keyterm prompting can be switched on and stays on", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Use keyterm prompting" });
  const was = (await bootstrap(page)).settings.stt_keyterms_enabled;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(!was));
  await page.reload();
  await expect(page.getByRole("switch", { name: "Use keyterm prompting" })).toHaveAttribute("aria-checked", String(!was));
  await api(page, "PUT", "/api/settings/stt_keyterms_enabled", { value: was });
});

test("Sign out this browser goes to the phrase page and ends the session", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, 2);
  await page.goto("/settings");
  const mine = page.locator(".session-row").filter({ hasText: "This browser" });
  await expect(mine).toHaveCount(1);
  await page.getByRole("button", { name: "Sign out this browser" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/board");
  await expect(page).toHaveURL(/\/login\?next=%2Fboard$/);
  await expect(page.getByLabel("Enter your phrase")).toBeVisible();
  await context.close();
});
