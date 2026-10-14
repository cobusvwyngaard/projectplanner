import { beforeEach, describe, expect, it } from "vitest";
import type { MutationResponse } from "../../src/shared/api";
import type { Label, SettingsMap, User } from "../../src/shared/types";
import { asUser, fails, ok, type TestApi } from "../helpers/api";
import { USER_1, USER_2, allEvents, eventsFor, freshDb } from "../helpers/db";

let db: D1Database;
let api: TestApi;

beforeEach(async () => {
  db = await freshDb();
  api = asUser(USER_1);
});

async function createLabel(name: string, colour_hex = "#0F766E") {
  return ok(api.post<MutationResponse<Label>>("/api/labels", { name, colour_hex }));
}

async function labelOrder() {
  const { results } = await db.prepare("SELECT name FROM labels ORDER BY sort_order, created_at").all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("POST /api/labels", () => {
  it("creates labels at the end of the list with lower-case colours", async () => {
    const result = await api.post<MutationResponse<Label>>("/api/labels", { name: "  Garden ", colour_hex: "#A3E635" });
    expect(result.status).toBe(201);
    expect(result.body.row).toMatchObject({ name: "Garden", colour_hex: "#a3e635", sort_order: 0, archived_at: null });
    expect(result.body.event).toMatchObject({ action: "create", entity_type: "label", actor_user_id: USER_1 });
    const second = await createLabel("Work");
    expect(second.row.sort_order).toBe(1);
  });

  it("keeps names unique among active labels, ignoring case", async () => {
    const home = await createLabel("Home");
    const clash = await fails(api.post("/api/labels", { name: "HOME", colour_hex: "#000000" }), 400);
    expect(clash).toMatchObject({ code: "invalid_request", message: 'There is already a label called "Home".' });
    await ok(api.post(`/api/labels/${home.row.id}/archive`));
    // An archived label's name can be used again.
    await createLabel("home");
  });

  it.each([
    ["an empty name", { name: "  ", colour_hex: "#000000" }, "name: Give the label a name."],
    ["a long name", { name: "x".repeat(41), colour_hex: "#000000" }, "name: A label name can be at most 40 characters."],
    ["a short colour", { name: "x", colour_hex: "#fff" }, "colour_hex: A colour must be written as #rrggbb, for example #1d4ed8."],
    ["a named colour", { name: "x", colour_hex: "red" }, "colour_hex: A colour must be written as #rrggbb, for example #1d4ed8."],
    ["a missing colour", { name: "x" }, "colour_hex: Invalid input: expected string, received undefined"],
    ["a sort order", { name: "x", colour_hex: "#000000", sort_order: 3 }, 'request: Unrecognized key: "sort_order"'],
  ])("refuses %s", async (_name, body, message) => {
    expect(await fails(api.post("/api/labels", body), 400)).toMatchObject({ message });
  });
});

describe("PATCH /api/labels/:id", () => {
  it("renames and recolours", async () => {
    const label = await createLabel("Home");
    const { row, event } = await ok(
      api.patch<MutationResponse<Label>>(`/api/labels/${label.row.id}`, { name: "House", colour_hex: "#FFFFFF" }),
    );
    expect(row).toMatchObject({ name: "House", colour_hex: "#ffffff" });
    expect(event).toMatchObject({ before: { name: "Home", colour_hex: "#0f766e" }, after: { name: "House", colour_hex: "#ffffff" } });
  });

  it("allows a change of case but not another label's name", async () => {
    const home = await createLabel("Home");
    await createLabel("Work");
    await ok(api.patch(`/api/labels/${home.row.id}`, { name: "HOME" }));
    await fails(api.patch(`/api/labels/${home.row.id}`, { name: "work" }), 400);
  });

  it("answers 404 for unknown labels and 400 for bad fields", async () => {
    await fails(api.patch("/api/labels/NOPE", { name: "x" }), 404);
    const label = await createLabel("Home");
    await fails(api.patch(`/api/labels/${label.row.id}`, { sort_order: 4 }), 400);
    await fails(api.patch(`/api/labels/${label.row.id}`, { colour_hex: "#12345g" }), 400);
  });
});

describe("POST /api/labels/reorder", () => {
  it("sets sort_order to each label's position in one transaction", async () => {
    const a = await createLabel("A");
    const b = await createLabel("B");
    const c = await createLabel("C");
    const archived = await createLabel("Old");
    await ok(api.post(`/api/labels/${archived.row.id}/archive`));
    const before = (await allEvents()).length;

    const { labels } = await ok(
      api.post<{ labels: Label[] }>("/api/labels/reorder", { ids: [c.row.id, a.row.id, b.row.id] }),
    );
    // All labels come back, archived ones included, in the new order.
    expect(labels.map((l) => [l.name, l.sort_order])).toEqual([
      ["C", 0],
      ["A", 1],
      ["B", 2],
      ["Old", 3],
    ]);
    const events = (await allEvents()).slice(before);
    expect(events.map((e) => e.entity_id).sort()).toEqual([a.row.id, b.row.id, c.row.id].sort());
    expect(events.every((e) => e.action === "update" && Object.keys(e.after ?? {}).join() === "sort_order")).toBe(true);
    // All three were written in one batch, so their seqs are consecutive.
    expect(events.map((e) => e.seq)).toEqual([events[0]!.seq, events[0]!.seq + 1, events[0]!.seq + 2]);
    expect(await labelOrder()).toEqual(["C", "A", "B", "Old"]);
  });

  it("writes no events when the order is unchanged", async () => {
    const a = await createLabel("A");
    const b = await createLabel("B");
    const before = (await allEvents()).length;
    await ok(api.post("/api/labels/reorder", { ids: [a.row.id, b.row.id] }));
    expect(await allEvents()).toHaveLength(before);
  });

  it("refuses anything but every active label exactly once", async () => {
    const a = await createLabel("A");
    const b = await createLabel("B");
    const old = await createLabel("Old");
    await ok(api.post(`/api/labels/${old.row.id}/archive`));
    const message = "List every label that is not archived exactly once.";
    for (const ids of [[a.row.id], [a.row.id, a.row.id], [a.row.id, b.row.id, old.row.id], [a.row.id, "NOPE"], []]) {
      expect(await fails(api.post("/api/labels/reorder", { ids }), 400)).toMatchObject({ message });
    }
    await fails(api.post("/api/labels/reorder", { ids: "a,b" }), 400);
    expect(await labelOrder()).toEqual(["A", "B", "Old"]);
  });
});

describe("archiving labels", () => {
  it("archives and unarchives", async () => {
    const label = await createLabel("Home");
    const archived = await ok(api.post<MutationResponse<Label>>(`/api/labels/${label.row.id}/archive`));
    expect(archived.event?.action).toBe("archive");
    expect(archived.row.archived_at).not.toBeNull();
    const back = await ok(api.post<MutationResponse<Label>>(`/api/labels/${label.row.id}/unarchive`));
    expect(back.row.archived_at).toBeNull();
  });

  it("refuses to unarchive a label whose name is taken again", async () => {
    const old = await createLabel("Home");
    await ok(api.post(`/api/labels/${old.row.id}/archive`));
    await createLabel("HOME");
    const error = await fails(api.post(`/api/labels/${old.row.id}/unarchive`), 400);
    expect(error.message).toBe('There is already a label called "HOME".');
  });

  it("clears the default label when it is archived, in the same transaction", async () => {
    const label = await createLabel("Home");
    await ok(api.put(`/api/settings/default_label_id`, { value: label.row.id }));
    await ok(api.post(`/api/labels/${label.row.id}/archive`));
    const settings = await db.prepare("SELECT value_json FROM settings WHERE key = 'default_label_id'").first("value_json");
    expect(settings).toBe("null");
    const events = await allEvents();
    const [archive, setting] = events.slice(-2);
    expect(archive).toMatchObject({ entity_type: "label", action: "archive" });
    expect(setting).toMatchObject({ entity_type: "setting", entity_id: "default_label_id", after: { value_json: "null" } });
    expect(setting!.seq).toBe(archive!.seq + 1);
  });

  it("answers 404 for unknown labels", async () => {
    await fails(api.post("/api/labels/NOPE/archive"), 404);
    await fails(api.post("/api/labels/NOPE/unarchive"), 404);
  });
});

describe("PATCH /api/users/:id", () => {
  it("changes display names and initials, either person's", async () => {
    const { row, event } = await ok(
      api.patch<MutationResponse<User>>(`/api/users/${USER_2}`, { display_name: "  Anna  ", initials: " ak " }),
    );
    expect(row).toMatchObject({ id: USER_2, display_name: "Anna", initials: "AK" });
    expect(event).toMatchObject({
      entity_type: "user",
      entity_id: USER_2,
      actor_user_id: USER_1,
      before: { display_name: "Person 2", initials: "P2" },
      after: { display_name: "Anna", initials: "AK" },
    });
    const digits = await ok(api.patch<MutationResponse<User>>(`/api/users/${USER_1}`, { initials: "c1" }));
    expect(digits.row.initials).toBe("C1");
  });

  it.each([
    ["an empty name", { display_name: " " }, "display_name: A name cannot be empty."],
    ["a long name", { display_name: "x".repeat(41) }, "display_name: A name can be at most 40 characters."],
    ["four initials", { initials: "ABCD" }, "initials: Initials must be 1 to 3 letters or digits."],
    ["punctuation in initials", { initials: "A.B" }, "initials: Initials must be 1 to 3 letters or digits."],
    ["empty initials", { initials: "" }, "initials: Initials must be 1 to 3 letters or digits."],
    ["an email change", { email: "someone@example.com" }, 'request: Unrecognized key: "email"'],
  ])("refuses %s", async (_name, body, message) => {
    expect(await fails(api.patch(`/api/users/${USER_1}`, body), 400)).toMatchObject({ message });
  });

  it("answers 404 for unknown users", async () => {
    await fails(api.patch("/api/users/NOPE", { display_name: "x" }), 404);
  });
});

describe("PUT /api/settings/:key", () => {
  it("stores keyterms trimmed and returns every setting", async () => {
    const { settings } = await ok(
      api.put<{ settings: SettingsMap }>("/api/settings/stt_keyterms", { value: [" Cobus ", "Shared Planner"] }),
    );
    expect(settings).toEqual({
      stt_keyterms: ["Cobus", "Shared Planner"],
      stt_keyterms_enabled: false,
      default_label_id: null,
    });
    const [event] = await eventsFor("setting", "stt_keyterms");
    expect(event).toMatchObject({
      action: "update",
      actor_user_id: USER_1,
      before: { value_json: "[]" },
      after: { value_json: '["Cobus","Shared Planner"]' },
    });
  });

  it("switches keyterms on and sets the default label", async () => {
    const label = await createLabel("Home");
    await ok(api.put("/api/settings/stt_keyterms_enabled", { value: true }));
    const { settings } = await ok(
      api.put<{ settings: SettingsMap }>("/api/settings/default_label_id", { value: label.row.id }),
    );
    expect(settings).toMatchObject({ stt_keyterms_enabled: true, default_label_id: label.row.id });
    const cleared = await ok(api.put<{ settings: SettingsMap }>("/api/settings/default_label_id", { value: null }));
    expect(cleared.settings.default_label_id).toBeNull();
  });

  it("creates the row when it is missing", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'stt_keyterms_enabled'").run();
    const { settings } = await ok(api.put<{ settings: SettingsMap }>("/api/settings/stt_keyterms_enabled", { value: true }));
    expect(settings.stt_keyterms_enabled).toBe(true);
    const [event] = await eventsFor("setting", "stt_keyterms_enabled");
    expect(event).toMatchObject({ action: "create", after: { key: "stt_keyterms_enabled", value_json: "true" } });
  });

  it("refuses values that break each setting's rules", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `term ${i}`);
    await ok(api.put("/api/settings/stt_keyterms", { value: tooMany.slice(0, 100) }));
    const cases: [string, unknown, string][] = [
      ["stt_keyterms", tooMany, "value: There can be at most 100 keyterms."],
      ["stt_keyterms", ["ok", "  "], "value.1: A keyterm cannot be empty."],
      ["stt_keyterms", ["x".repeat(51)], "value.0: A keyterm can be at most 50 characters."],
      ["stt_keyterms", "Cobus", "value: Invalid input: expected array, received string"],
      ["stt_keyterms_enabled", "yes", "value: Invalid input: expected boolean, received string"],
      ["default_label_id", "NO-SUCH-LABEL", "That label does not exist."],
    ];
    for (const [key, value, message] of cases) {
      expect(await fails(api.put(`/api/settings/${key}`, { value }), 400), key).toMatchObject({ message });
    }
    await fails(api.put("/api/settings/stt_keyterms_enabled", {}), 400);
    await fails(api.put("/api/settings/stt_keyterms_enabled", { value: true, other: 1 }), 400);
  });

  it("refuses an archived default label", async () => {
    const label = await createLabel("Home");
    await ok(api.post(`/api/labels/${label.row.id}/archive`));
    const error = await fails(api.put("/api/settings/default_label_id", { value: label.row.id }), 400);
    expect(error.message).toMatch(/archived/);
  });

  it("answers 404 for settings it does not know", async () => {
    const error = await fails(api.put("/api/settings/theme", { value: "dark" }), 404);
    expect(error.code).toBe("not_found");
    await fails(api.put("/api/settings/constructor", { value: 1 }), 404);
  });
});
