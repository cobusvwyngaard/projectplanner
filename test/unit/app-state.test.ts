import { describe, expect, it } from "vitest";
import {
  applyChanges,
  applyMutation,
  fromBootstrap,
  markPending,
  putRow,
  rolledToday,
  rowKey,
  settleChange,
} from "../../src/app/lib/state";
import { ME, OTHER, bootstrap, changes, event, label, link, note, task, userEmail } from "./app-fixtures";

describe("fromBootstrap", () => {
  it("keys every collection by id and keeps archived labels", () => {
    const state = fromBootstrap(
      bootstrap({
        notes: [note({ id: "N1" })],
        tasks: [task({ id: "T1" }), task({ id: "T2", status: "done" })],
        links: [link({ id: "L1" })],
        labels: [label({ id: "A" }), label({ id: "B", archived_at: "2026-10-01T00:00:00.000Z" })],
      }),
    );
    expect([...state.notes.keys()]).toEqual(["N1"]);
    expect([...state.tasks.keys()]).toEqual(["T1", "T2"]);
    expect([...state.links.keys()]).toEqual(["L1"]);
    expect([...state.labels.keys()]).toEqual(["A", "B"]);
    expect(state.users.get(OTHER.id)).toEqual(OTHER);
    expect(state.me).toEqual(ME);
    expect(state.cursor).toBe("E10");
    expect(state.today).toBe("2026-10-14");
  });

  it("keeps open email addresses and drops archived ones", () => {
    const state = fromBootstrap(
      bootstrap({
        user_emails: [
          userEmail({ id: "M1", address: "cobus@example.com" }),
          userEmail({ id: "M2", user_id: OTHER.id, address: "anna@example.com", archived_at: "2026-10-01T00:00:00.000Z" }),
        ],
      }),
    );
    expect([...state.emails.keys()]).toEqual(["M1"]);
    expect(state.emails.get("M1")?.address).toBe("cobus@example.com");
  });
});

describe("putRow", () => {
  const base = fromBootstrap(bootstrap({ notes: [note({ id: "N1" })], labels: [label({ id: "A" })] }));

  it("adds and replaces live rows", () => {
    const added = putRow(base, "task", task({ id: "T9" }));
    expect(added.tasks.get("T9")?.title).toBe("Task T9");
    const renamed = putRow(added, "note", note({ id: "N1", title: "Renamed" }));
    expect(renamed.notes.get("N1")?.title).toBe("Renamed");
    expect(renamed.tasks).toBe(added.tasks);
  });

  it("removes archived notes, tasks and links", () => {
    const archived = putRow(base, "note", note({ id: "N1", archived_at: "2026-10-14T07:00:00.000Z" }));
    expect(archived.notes.has("N1")).toBe(false);
    // Archiving something that is not loaded changes nothing.
    expect(putRow(base, "link", link({ id: "L5", archived_at: "2026-10-14T07:00:00.000Z" }))).toBe(base);
  });

  it("keeps archived labels so old items still show their colour", () => {
    const next = putRow(base, "label", label({ id: "A", archived_at: "2026-10-14T07:00:00.000Z" }));
    expect(next.labels.get("A")?.archived_at).not.toBeNull();
  });

  it("updates me when the signed-in person changes", () => {
    const next = putRow(base, "user", { ...ME, display_name: "Cobus W" });
    expect(next.me.display_name).toBe("Cobus W");
    const other = putRow(base, "user", { ...OTHER, display_name: "Anna B" });
    expect(other.me).toBe(base.me);
  });

  it("returns the same state when the row is already there", () => {
    const row = base.notes.get("N1");
    if (!row) throw new Error("missing");
    expect(putRow(base, "note", row)).toBe(base);
  });

  it("adds an email address and removes an archived one", () => {
    const base = fromBootstrap(bootstrap({ user_emails: [userEmail({ id: "M1" })] }));
    const added = putRow(base, "user_email", userEmail({ id: "M2", user_id: OTHER.id }));
    expect(added.emails.get("M2")?.user_id).toBe(OTHER.id);
    const archived = putRow(added, "user_email", userEmail({ id: "M1", archived_at: "2026-10-14T07:00:00.000Z" }));
    expect(archived.emails.has("M1")).toBe(false);
    expect(archived.emails.has("M2")).toBe(true);
  });
});

describe("applyChanges", () => {
  it("applies rows, removes archived ones and moves the cursor", () => {
    const base = fromBootstrap(bootstrap({ notes: [note({ id: "N1" })], tasks: [task({ id: "T1" })] }));
    const next = applyChanges(
      base,
      changes({
        events: [event({ seq: 11 }), event({ seq: 12 })],
        notes: [note({ id: "N1", archived_at: "2026-10-14T07:00:00.000Z" }), note({ id: "N2" })],
        tasks: [task({ id: "T1", status: "done" })],
        links: [link({ id: "L1" })],
        users: [{ ...OTHER, initials: "AB" }],
        settings: { stt_keyterms: ["Planner"], stt_keyterms_enabled: true, default_label_id: null },
        cursor: "E12",
      }),
    );
    expect([...next.notes.keys()]).toEqual(["N2"]);
    expect(next.tasks.get("T1")?.status).toBe("done");
    expect(next.links.has("L1")).toBe(true);
    expect(next.users.get(OTHER.id)?.initials).toBe("AB");
    expect(next.settings.stt_keyterms).toEqual(["Planner"]);
    expect(next.cursor).toBe("E12");
  });

  it("brings a new email address from the change feed and drops an archived one", () => {
    const base = fromBootstrap(bootstrap({ user_emails: [userEmail({ id: "M1", address: "cobus@example.com" })] }));
    const next = applyChanges(
      base,
      changes({
        events: [event({ seq: 11, entity_type: "user_email" }), event({ seq: 12, entity_type: "user_email" })],
        user_emails: [
          userEmail({ id: "M1", address: "cobus@example.com", archived_at: "2026-10-14T07:00:00.000Z" }),
          userEmail({ id: "M2", user_id: OTHER.id, address: "anna@example.com" }),
        ],
        cursor: "E12",
      }),
    );
    expect([...next.emails.keys()]).toEqual(["M2"]);
    expect(next.emails.get("M2")?.address).toBe("anna@example.com");
  });

  it("leaves a row alone while a change of ours to it is in flight", () => {
    let state = fromBootstrap(bootstrap({ notes: [note({ id: "N1", x: 0 })] }));
    state = markPending(state, rowKey("note", "N1"), 1);
    state = putRow(state, "note", note({ id: "N1", x: 300 }));
    const polled = applyChanges(state, changes({ events: [event({ seq: 11 })], notes: [note({ id: "N1", x: 0 })], cursor: "E11" }));
    expect(polled.notes.get("N1")?.x).toBe(300);
    expect(polled.cursor).toBe("E11");
    // Once the change is answered, the feed applies again.
    const settled = applyChanges(markPending(polled, rowKey("note", "N1"), -1), changes({
      events: [event({ seq: 12 })],
      notes: [note({ id: "N1", x: 300, title: "Moved" })],
      cursor: "E12",
    }));
    expect(settled.notes.get("N1")?.title).toBe("Moved");
  });

  it("ignores rows older than our own committed change", () => {
    let state = fromBootstrap(bootstrap({ notes: [note({ id: "N1", x: 0 })] }));
    state = applyMutation(state, "note", { row: note({ id: "N1", x: 300 }), event: event({ seq: 20 }) });
    // A poll answered before our change committed: its events stop at seq 15.
    const stale = applyChanges(state, changes({ events: [event({ seq: 15 })], notes: [note({ id: "N1", x: 0 })], cursor: "E15" }));
    expect(stale.notes.get("N1")?.x).toBe(300);
    // The next poll reaches our event and takes over again.
    const fresh = applyChanges(stale, changes({ events: [event({ seq: 20 })], notes: [note({ id: "N1", x: 300 })], cursor: "E20" }));
    expect(fresh.seen.has(rowKey("note", "N1"))).toBe(false);
    const later = applyChanges(fresh, changes({ events: [event({ seq: 21 })], notes: [note({ id: "N1", x: 50 })], cursor: "E21" }));
    expect(later.notes.get("N1")?.x).toBe(50);
  });
});

describe("applyMutation", () => {
  it("puts the returned row and remembers the event seq", () => {
    const state = fromBootstrap(bootstrap());
    const next = applyMutation(state, "task", { row: task({ id: "T1" }), event: event({ seq: 30, entity_type: "task" }) });
    expect(next.tasks.has("T1")).toBe(true);
    expect(next.seen.get(rowKey("task", "T1"))).toBe(30);
    const noop = applyMutation(next, "task", { row: task({ id: "T1", title: "Same" }), event: null });
    expect(noop.seen.get(rowKey("task", "T1"))).toBe(30);
  });

  it("leaves a row that a later change of ours already moved past", () => {
    let state = fromBootstrap(bootstrap({ notes: [note({ id: "N1" })] }));
    state = applyMutation(state, "note", { row: note({ id: "N1", x: 200, title: "Second" }), event: event({ seq: 41 }) });
    const older = applyMutation(state, "note", { row: note({ id: "N1", x: 100 }), event: event({ seq: 40 }) });
    expect(older).toBe(state);
  });

  it("removes an archived row", () => {
    const state = fromBootstrap(bootstrap({ tasks: [task({ id: "T1" })] }));
    const next = applyMutation(state, "task", {
      row: task({ id: "T1", archived_at: "2026-10-14T08:00:00.000Z" }),
      event: event({ seq: 31, action: "archive" }),
    });
    expect(next.tasks.has("T1")).toBe(false);
  });
});

describe("settleChange", () => {
  const key = rowKey("note", "N1");
  /** N1 with a change of ours in flight (moved to x 100) and a poll that brought `polled`. */
  function inFlight(polled: ReturnType<typeof note>, reach: number, changesInFlight = 1) {
    let state = fromBootstrap(bootstrap({ notes: [note({ id: "N1", title: "Old" })] }));
    for (let i = 0; i < changesInFlight; i++) state = markPending(state, key, 1);
    state = putRow(state, "note", note({ id: "N1", title: "Old", x: 100 }));
    return applyChanges(state, changes({ events: [event({ seq: reach })], notes: [polled], cursor: `E${reach}` }));
  }

  it("holds a row the feed skipped and applies it when it is newer than our answer", () => {
    const state = inFlight(note({ id: "N1", title: "New", x: 100 }), 12);
    expect(state.notes.get("N1")?.title).toBe("Old");
    expect(state.held.get(key)).toMatchObject({ kind: "note", reach: 12 });
    const next = settleChange(state, "note", "N1", { row: note({ id: "N1", title: "Old", x: 100 }), event: event({ seq: 11 }) }, undefined);
    expect(next.notes.get("N1")).toMatchObject({ title: "New", x: 100 });
    expect(next.held.size).toBe(0);
    expect(next.pending.size).toBe(0);
    expect(next.seen.has(key)).toBe(false);
  });

  it("keeps our answer when our change committed after the held poll", () => {
    const state = inFlight(note({ id: "N1", title: "New" }), 11);
    const next = settleChange(
      state, "note", "N1", { row: note({ id: "N1", title: "New", x: 100 }), event: event({ seq: 12 }) }, undefined,
    );
    expect(next.notes.get("N1")).toMatchObject({ title: "New", x: 100 });
    expect(next.held.size).toBe(0);
    expect(next.seen.get(key)).toBe(12);
  });

  it("restores the held row, not the row from before, when the change fails", () => {
    const state = inFlight(note({ id: "N1", title: "New" }), 11);
    const next = settleChange(state, "note", "N1", null, note({ id: "N1", title: "Old" }));
    expect(next.notes.get("N1")).toMatchObject({ title: "New", x: 0 });
    expect(next.held.size).toBe(0);
  });

  it("restores the row from before when nothing was held", () => {
    let state = fromBootstrap(bootstrap({ notes: [note({ id: "N1", title: "Old" })] }));
    state = putRow(markPending(state, key, 1), "note", note({ id: "N1", title: "Old", x: 100 }));
    const next = settleChange(state, "note", "N1", null, note({ id: "N1", title: "Old" }));
    expect(next.notes.get("N1")?.x).toBe(0);
  });

  it("keeps holding the row while another change of ours to it is in flight", () => {
    const state = inFlight(note({ id: "N1", title: "New", x: 100 }), 12, 2);
    const first = settleChange(state, "note", "N1", { row: note({ id: "N1", title: "Old", x: 100 }), event: event({ seq: 11 }) }, undefined);
    expect(first.held.has(key)).toBe(true);
    expect(first.notes.get("N1")?.title).toBe("Old");
    const second = settleChange(first, "note", "N1", { row: note({ id: "N1", title: "Old", x: 100 }), event: null }, undefined);
    expect(second.notes.get("N1")?.title).toBe("New");
  });
});

describe("markPending", () => {
  it("counts overlapping changes", () => {
    let state = fromBootstrap(bootstrap());
    state = markPending(markPending(state, "note:N1", 1), "note:N1", 1);
    expect(state.pending.get("note:N1")).toBe(2);
    state = markPending(markPending(state, "note:N1", -1), "note:N1", -1);
    expect(state.pending.has("note:N1")).toBe(false);
  });
});

describe("rolledToday", () => {
  it("keeps the server's date until the local date moves on", () => {
    expect(rolledToday("2026-10-14", "2026-10-14", "2026-10-14")).toBe("2026-10-14");
    expect(rolledToday("2026-10-14", "2026-10-14", "2026-10-15")).toBe("2026-10-15");
    // A browser clock a day behind still moves the server's date on by the days that passed.
    expect(rolledToday("2026-10-14", "2026-10-13", "2026-10-15")).toBe("2026-10-16");
    expect(rolledToday("2026-10-14", "2026-10-14", "2026-10-13")).toBe("2026-10-14");
  });
});
