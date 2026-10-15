import { beforeEach, describe, expect, it } from "vitest";
import { localDayStart } from "../../src/worker/board/activity";
import { GAP } from "../../src/shared/placement";
import { DEFAULT_NOTE_SIZE, freeSpot, placeNote } from "../../src/worker/board/placement";
import { chunk, placeholders } from "../../src/worker/board/queries";
import { captureTitle, excerpt, noteTitle, titlesFor } from "../../src/worker/board/titles";
import { humanActor } from "../../src/worker/mutate/actor";
import { mutate } from "../../src/worker/mutate/index";
import { readSettings } from "../../src/worker/settings";
import { USER_1, freshDb } from "../helpers/db";

let db: D1Database;

beforeEach(async () => {
  db = await freshDb();
});

describe("titles", () => {
  it("squeezes text onto one line and cuts it to 60 characters", () => {
    expect(excerpt("  Buy\n\tpaint  ")).toBe("Buy paint");
    const long = excerpt("a".repeat(100));
    expect(long).toBe(`${"a".repeat(59)}…`);
    expect(excerpt("x".repeat(60))).toBe("x".repeat(60));
    // Characters outside the basic plane count once.
    expect(Array.from(excerpt("🎨".repeat(70)))).toHaveLength(60);
  });

  it("names untitled notes by their body, and captures without text by their kind", () => {
    expect(noteTitle({ title: "Trip", body: "ignored" })).toBe("Trip");
    expect(noteTitle({ title: " ", body: "Packing list for the coast" })).toBe("Packing list for the coast");
    expect(noteTitle({ title: "", body: "" })).toBe("Untitled note");
    expect(captureTitle({ kind: "voice", text: null })).toBe("Voice capture");
    expect(captureTitle({ kind: "text", text: "  " })).toBe("Text capture");
    expect(captureTitle({ kind: "file", text: "Quote for the roof" })).toBe("Quote for the roof");
  });

  it("leaves out entities that do not exist", async () => {
    const note = await mutate(db, humanActor(USER_1), { entity: "note", action: "create", values: { title: "Here" } });
    expect(
      await titlesFor(db, [
        { type: "note", id: note.id },
        { type: "note", id: "MISSING" },
        { type: "link", id: "MISSING" },
      ]),
    ).toEqual({ [`note:${note.id}`]: "Here" });
  });
});

describe("placement", () => {
  it("takes the first free cell and keeps a gap", () => {
    const size = { w: 200, h: 100 };
    expect(freeSpot(size, [])).toEqual({ x: 0, y: 0 });
    expect(freeSpot(size, [{ x: 0, y: 0, w: 200, h: 100 }])).toEqual({ x: 200 + GAP, y: 0 });
    // Something just inside the gap still counts as in the way.
    expect(freeSpot(size, [{ x: 200 + GAP - 1, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }])).toEqual({
      x: 2 * (200 + GAP),
      y: 0,
    });
  });

  it("goes below everything when the grid is full", () => {
    const wall = { x: -100, y: -100, w: 1_000_000, h: 50_000 };
    expect(freeSpot({ w: 200, h: 100 }, [wall])).toEqual({ x: 0, y: 49_900 + GAP });
  });

  it("avoids open notes and placed tasks but not archived ones", async () => {
    const human = humanActor(USER_1);
    await mutate(db, human, { entity: "note", action: "create", values: { title: "a", x: 0, y: 0 } });
    const archived = await mutate(db, human, {
      entity: "note",
      action: "create",
      values: { title: "b", x: DEFAULT_NOTE_SIZE.w + GAP, y: 0 },
    });
    await mutate(db, human, { entity: "note", action: "archive", id: archived.id });
    expect(await placeNote(db, DEFAULT_NOTE_SIZE)).toEqual({ x: DEFAULT_NOTE_SIZE.w + GAP, y: 0 });
    await mutate(db, human, { entity: "task", action: "create", values: { title: "t", x: DEFAULT_NOTE_SIZE.w + GAP, y: 0 } });
    expect(await placeNote(db, DEFAULT_NOTE_SIZE)).toEqual({ x: 2 * (DEFAULT_NOTE_SIZE.w + GAP), y: 0 });
  });
});

describe("helpers", () => {
  it("splits id lists and writes placeholders", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(placeholders(3)).toBe("?, ?, ?");
  });

  it("starts a local day at 22:00 UTC the day before", () => {
    expect(localDayStart("2026-03-02")).toBe("2026-03-01T22:00:00.000Z");
    expect(localDayStart("2026-01-01")).toBe("2025-12-31T22:00:00.000Z");
  });
});

describe("settings registry", () => {
  it("falls back for missing or unreadable values", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'stt_keyterms'").run();
    await db.prepare("UPDATE settings SET value_json = 'not json' WHERE key = 'stt_keyterms_enabled'").run();
    await db.prepare(`UPDATE settings SET value_json = '42' WHERE key = 'default_label_id'`).run();
    expect(await readSettings(db)).toEqual({ stt_keyterms: [], stt_keyterms_enabled: false, default_label_id: null });
  });
});
