import { describe, expect, it } from "vitest";
import { describeEvent, eventChanges, fieldLabel, isRevertible, type DescribeContext } from "../../src/app/lib/events";
import { ME, OTHER, event, label } from "./app-fixtures";

const ctx: DescribeContext = {
  users: new Map([
    [ME.id, ME],
    [OTHER.id, OTHER],
  ]),
  labels: new Map([
    ["LA", label({ id: "LA", name: "Garden", colour_hex: "#86efac" })],
    ["LB", label({ id: "LB", name: "House", colour_hex: "#1e3a8a" })],
  ]),
  titles: { "note:N1": "Plan the trip", "task:T1": "Book flights", "link:L1": "Link: Plan the trip ↔ Book flights" },
};

describe("describeEvent", () => {
  it("says who did what to which item", () => {
    const view = describeEvent(event({ seq: 1, entity_type: "task", entity_id: "T1", action: "complete", before: { status: "open" }, after: { status: "done" } }), ctx);
    expect(view).toMatchObject({ actor: "Cobus", verb: "ticked off", noun: "the task", title: "Book flights", suffix: "", revertible: true });
    expect(view.changes).toEqual([]);
  });

  it("names Claude with the person it acted for", () => {
    const view = describeEvent(event({ seq: 2, actor_kind: "claude", actor_user_id: OTHER.id, run_id: "R1", action: "create", after: { id: "N1", title: "Plan the trip", body: "" } }), ctx);
    expect(view.actor).toBe("Claude (via Anna)");
    expect(view.verb).toBe("created");
  });

  it("describes moves on the board in words", () => {
    const placed = describeEvent(event({ seq: 3, entity_type: "task", entity_id: "T1", before: { x: null, y: null }, after: { x: 10, y: 20 } }), ctx);
    expect(placed).toMatchObject({ verb: "placed", suffix: "on the board" });
    expect(placed.changes).toEqual([{ field: "position", label: "Position", before: "Not on the board", after: "10, 20" }]);
    const removed = describeEvent(event({ seq: 4, entity_type: "task", entity_id: "T1", before: { x: 10, y: 20 }, after: { x: null, y: null } }), ctx);
    expect(removed).toMatchObject({ verb: "took", suffix: "off the board" });
    const moved = describeEvent(event({ seq: 5, before: { x: 10.4, y: 20 }, after: { x: 30, y: 20 } }), ctx);
    expect(moved.verb).toBe("moved");
    expect(moved.changes[0]).toMatchObject({ before: "10, 20", after: "30, 20" });
    const sideways = describeEvent(event({ seq: 6, before: { x: 10 }, after: { x: 40 } }), ctx);
    expect(sideways.changes[0]).toMatchObject({ before: "x 10", after: "x 40" });
    const resized = describeEvent(event({ seq: 7, before: { w: 240 }, after: { w: 300 } }), ctx);
    expect(resized.verb).toBe("resized");
    expect(resized.changes).toEqual([{ field: "size", label: "Size", before: "240 wide", after: "300 wide" }]);
    const both = describeEvent(event({ seq: 8, before: { w: 240, h: 160, x: 0 }, after: { w: 300, h: 200, x: -60 } }), ctx);
    expect(both.verb).toBe("resized");
    expect(both.changes.map((c) => [c.label, c.before, c.after])).toEqual([
      ["Position", "x 0", "x -60"],
      ["Size", "240 × 160", "300 × 200"],
    ]);
  });

  it("uses the link's two titles", () => {
    const view = describeEvent(event({ seq: 9, entity_type: "link", entity_id: "L1", action: "create", after: { id: "L1", a_type: "note", a_id: "N1", b_type: "task", b_id: "T1" } }), ctx);
    expect(view).toMatchObject({ verb: "linked", noun: "", title: "Plan the trip ↔ Book flights" });
    expect(view.changes).toEqual([]);
  });

  it("describes sign-ins and settings", () => {
    expect(describeEvent(event({ seq: 8, entity_type: "session", entity_id: "S1", action: "login" }), ctx)).toMatchObject({
      verb: "signed in",
      noun: "",
      title: null,
      revertible: false,
    });
    const setting = describeEvent(
      event({ seq: 9, entity_type: "setting", entity_id: "stt_keyterms_enabled", before: { value_json: "false" }, after: { value_json: "true" } }),
      ctx,
    );
    expect(setting).toMatchObject({ verb: "changed", noun: "the setting", title: "Keyterm prompting" });
    expect(setting.changes).toEqual([{ field: "value_json", label: "Keyterm prompting", before: "Off", after: "On" }]);
  });

  it("names the client of a disconnected Claude connection", () => {
    const view = describeEvent(
      event({
        seq: 17,
        entity_type: "claude_connection",
        entity_id: "G1",
        action: "session_revoke",
        before: { user_id: OTHER.id, client_name: "Claude Desktop" },
        after: null,
      }),
      ctx,
    );
    expect(view).toMatchObject({
      actor: "Cobus",
      verb: "disconnected",
      noun: "a Claude connection",
      title: null,
      suffix: "(Claude Desktop)",
      revertible: false,
    });
    expect(view.changes).toEqual([]);
  });

  it("leaves the client out when a disconnection has no name", () => {
    const view = describeEvent(
      event({ seq: 18, entity_type: "claude_connection", entity_id: "G2", action: "session_revoke", before: { user_id: ME.id } }),
      ctx,
    );
    expect(view).toMatchObject({ verb: "disconnected", noun: "a Claude connection", suffix: "" });
  });
});

describe("describeEvent email addresses", () => {
  it("says a person added an email address for another person", () => {
    const view = describeEvent(
      event({
        seq: 40,
        entity_type: "user_email",
        entity_id: "M1",
        action: "create",
        after: { user_id: OTHER.id, address: "anna@example.com" },
      }),
      ctx,
    );
    expect(view).toMatchObject({ actor: "Cobus", verb: "added", noun: "an email address for Anna (anna@example.com)", title: null, suffix: "" });
    expect(view.changes).toEqual([]);
  });

  it("says a person removed an email address for another person", () => {
    const view = describeEvent(
      event({
        seq: 41,
        entity_type: "user_email",
        entity_id: "M1",
        action: "archive",
        before: { user_id: ME.id, address: "cobus@example.com" },
      }),
      ctx,
    );
    expect(view).toMatchObject({ actor: "Cobus", verb: "removed", noun: "an email address for Cobus (cobus@example.com)" });
    expect(view.revertible).toBe(false);
  });
});

describe("describeEvent attachments", () => {
  it("says the planner listed an attachment on an email", () => {
    const view = describeEvent(
      event({
        seq: 42,
        actor_kind: "system",
        actor_user_id: null,
        entity_type: "attachment",
        entity_id: "A1",
        action: "create",
        after: { capture_id: "C9", filename: "notes.pdf" },
      }),
      ctx,
    );
    expect(view).toMatchObject({ actor: "System", verb: "listed", noun: "an attachment (notes.pdf)", title: null, suffix: "on an email", revertible: false });
    expect(view.changes).toEqual([]);
  });

  it("names an attachment without a file name as \"Attachment\"", () => {
    const view = describeEvent(
      event({
        seq: 43,
        actor_kind: "system",
        actor_user_id: null,
        entity_type: "attachment",
        entity_id: "A2",
        action: "create",
        after: { capture_id: "C9", filename: "" },
      }),
      ctx,
    );
    expect(view).toMatchObject({ verb: "listed", noun: "an attachment (Attachment)", suffix: "on an email", revertible: false });
  });

  it("shows the email's title when the screen knows it", () => {
    const view = describeEvent(
      event({
        seq: 44,
        actor_kind: "system",
        actor_user_id: null,
        entity_type: "attachment",
        entity_id: "A3",
        action: "create",
        after: { capture_id: "C9", filename: "map.png" },
      }),
      { ...ctx, titles: { "capture:C9": "Trip planning" } },
    );
    expect(view).toMatchObject({ noun: "an attachment (map.png)", title: "Trip planning", suffix: "on an email" });
  });
});

describe("eventChanges", () => {
  it("shows labels, people and dates by name instead of ids", () => {
    const changes = eventChanges(
      event({
        seq: 10,
        entity_type: "task",
        before: { label_id: "LA", assignee_id: null, due_date: null, title: "Book flights" },
        after: { label_id: "LB", assignee_id: OTHER.id, due_date: "2026-10-20", title: "Book the flights" },
      }),
      ctx,
    );
    expect(changes).toEqual([
      { field: "label_id", label: "Label", before: "Garden", after: "House", beforeColour: "#86efac", afterColour: "#1e3a8a" },
      { field: "assignee_id", label: "Assigned to", before: "Nobody", after: "Anna" },
      { field: "due_date", label: "Due date", before: "No date", after: "20 Oct 2026" },
      { field: "title", label: "Title", before: "Book flights", after: "Book the flights" },
    ]);
  });

  it("summarises a creation by its meaningful values only", () => {
    const changes = eventChanges(
      event({
        seq: 11,
        entity_type: "task",
        action: "create",
        after: {
          id: "T1", title: "Book flights", detail: "", label_id: "LA", assignee_id: ME.id, due_date: null,
          status: "open", x: null, y: null, created_at: "x", updated_at: "x", archived_at: null,
        },
      }),
      ctx,
    );
    expect(changes.map((c) => [c.label, c.before, c.after])).toEqual([
      ["Title", null, "Book flights"],
      ["Label", null, "Garden"],
      ["Assigned to", null, "Cobus"],
    ]);
  });

  it("leaves archiving to the verb, but shows it for a revert", () => {
    expect(eventChanges(event({ seq: 12, action: "archive", before: { archived_at: null }, after: { archived_at: "2026-10-14T09:00:00Z" } }), ctx)).toEqual([]);
    expect(
      eventChanges(event({ seq: 13, action: "revert", reverts_event_id: "E1", before: { archived_at: null }, after: { archived_at: "2026-10-14T09:00:00Z" } }), ctx),
    ).toEqual([{ field: "archived_at", label: "Archived", before: "No", after: "Yes" }]);
  });

  it("shortens long text and marks empty text", () => {
    const [change] = eventChanges(event({ seq: 14, before: { body: "" }, after: { body: "word ".repeat(100) } }), ctx);
    expect(change?.before).toBe("(empty)");
    expect(change?.after.length).toBeLessThanOrEqual(140);
    expect(change?.after.endsWith("…")).toBe(true);
  });

  it("reads keyterm and default-label settings", () => {
    const [terms] = eventChanges(event({ seq: 15, entity_type: "setting", entity_id: "stt_keyterms", before: { value_json: "[]" }, after: { value_json: '["Cobus","Planner"]' } }), ctx);
    expect(terms).toMatchObject({ before: "None", after: "Cobus, Planner" });
    const [def] = eventChanges(event({ seq: 16, entity_type: "setting", entity_id: "default_label_id", before: { value_json: "null" }, after: { value_json: '"LB"' } }), ctx);
    expect(def).toMatchObject({ before: "None", after: "House" });
  });
});

describe("isRevertible", () => {
  it("offers revert for board changes but not for sign-ins or unarchivable creations", () => {
    expect(isRevertible(event({ seq: 1, action: "update", before: { title: "a" }, after: { title: "b" } }))).toBe(true);
    expect(isRevertible(event({ seq: 2, action: "create", after: { id: "N1" } }))).toBe(true);
    expect(isRevertible(event({ seq: 3, entity_type: "session", action: "login" }))).toBe(false);
    expect(isRevertible(event({ seq: 4, entity_type: "setting", entity_id: "k", action: "create", after: { key: "k" } }))).toBe(false);
    expect(isRevertible(event({ seq: 5, entity_type: "user", action: "update", before: { initials: "A" }, after: { initials: "B" } }))).toBe(true);
  });
});

describe("fieldLabel", () => {
  it("names fields in words", () => {
    expect(fieldLabel("assignee_id")).toBe("Assigned to");
    expect(fieldLabel("x")).toBe("Position");
    expect(fieldLabel("h")).toBe("Size");
    expect(fieldLabel("something_new")).toBe("Something new");
  });
});
