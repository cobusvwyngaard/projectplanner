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

test("an email address can be added for a person and removed", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/settings");
  const address = `planner-${unique("x").replace(/\s+/g, "-").toLowerCase()}@example.com`;

  const person1 = page.locator(".person-card").filter({ has: page.getByRole("heading", { name: " (you)" }) });
  const person2 = page.locator(".person-card").filter({ hasNot: page.getByRole("heading", { name: " (you)" }) });
  const field1 = person1.getByLabel("Add an email address");
  const field2 = person2.getByLabel("Add an email address");

  // Add it for Person 1 and see it listed.
  await field1.fill(address);
  await person1.getByRole("button", { name: "Add" }).click();
  await expect(person1.getByText(address)).toBeVisible();
  await expect(field1).toHaveValue("");
  await expect
    .poll(async () => (await bootstrap(page)).user_emails.filter((e) => e.archived_at === null).map((e) => e.address))
    .toContain(address);

  // The same address cannot belong to Person 2 as well.
  await field2.fill(address);
  await person2.getByRole("button", { name: "Add" }).click();
  await expect(person2.getByRole("alert")).toContainText("already belongs to");
  // The field keeps what was typed so it can be corrected.
  await expect(field2).toHaveValue(address);
  await expect
    .poll(async () => (await bootstrap(page)).user_emails.filter((e) => e.archived_at === null && e.address === address).length)
    .toBe(1);

  // Remove it.
  const row = person1.locator(".email-row").filter({ hasText: address });
  await row.getByRole("button", { name: "Remove" }).click();
  await row.locator(".confirm").getByRole("button", { name: "Remove" }).click();
  await expect(person1.getByText(address)).toHaveCount(0);
  await expect
    .poll(async () => (await bootstrap(page)).user_emails.filter((e) => e.archived_at === null).map((e) => e.address))
    .not.toContain(address);
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
