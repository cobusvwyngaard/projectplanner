import { describe, expect, it } from "vitest";
import { boardEdges, boardNodes, mergeEdges, mergeNodes, nodeItem, roundPosition, type BoardNode } from "../../src/app/lib/board";
import { asNote, asTask, itemKey, linksOf, parseItemKey, rebuildRow, searchItems } from "../../src/app/lib/items";
import { event, link, note, task } from "./app-fixtures";

describe("boardNodes and boardEdges", () => {
  it("places notes with their size and only placed tasks", () => {
    const nodes = boardNodes(
      [note({ id: "N1", x: 10, y: 20, w: 300, h: 200 })],
      [task({ id: "T1", x: 5, y: 6 }), task({ id: "T2" })],
    );
    expect(nodes).toEqual([
      { id: "note:N1", type: "note", position: { x: 10, y: 20 }, width: 300, height: 200, data: { id: "N1" } },
      { id: "task:T1", type: "task", position: { x: 5, y: 6 }, data: { id: "T1" } },
    ]);
    expect(nodeItem(nodes[1] as BoardNode)).toEqual({ type: "task", id: "T1" });
  });

  it("draws links only between items on the board", () => {
    const edges = boardEdges(
      [link({ id: "L1", a_id: "N1", b_id: "T1" }), link({ id: "L2", a_id: "N1", b_id: "T2" })],
      new Set(["note:N1", "task:T1"]),
    );
    expect(edges).toEqual([{ id: "link:L1", type: "link", source: "note:N1", target: "task:T1", data: { id: "L1" } }]);
  });
});

describe("mergeNodes", () => {
  const fresh = () => boardNodes([note({ id: "N1", x: 0, y: 0 }), note({ id: "N2", x: 50, y: 50 })], []);

  it("returns the shown array when nothing changed", () => {
    const shown = fresh();
    expect(mergeNodes(shown, fresh())).toBe(shown);
  });

  it("keeps a node the user is dragging or resizing", () => {
    const shown = fresh().map((n) => (n.id === "note:N1" ? { ...n, dragging: true, position: { x: 99, y: 99 } } : n));
    const next = boardNodes([note({ id: "N1", x: 5, y: 5 }), note({ id: "N2", x: 60, y: 50 })], []);
    const merged = mergeNodes(shown, next);
    expect(merged[0]).toBe(shown[0]);
    expect(merged[1]?.position).toEqual({ x: 60, y: 50 });
  });

  it("keeps selection and measured size when a node moves", () => {
    const shown = fresh().map((n) => ({ ...n, selected: n.id === "note:N2", measured: { width: 240, height: 160 } }));
    const next = boardNodes([note({ id: "N1", x: 0, y: 0 }), note({ id: "N2", x: 70, y: 80 })], []);
    const merged = mergeNodes(shown, next);
    expect(merged[0]).toBe(shown[0]);
    expect(merged[1]).toMatchObject({ position: { x: 70, y: 80 }, selected: true, measured: { width: 240, height: 160 } });
  });

  it("adds and drops nodes", () => {
    const shown = fresh();
    expect(mergeNodes(shown, fresh().slice(0, 1)).map((n) => n.id)).toEqual(["note:N1"]);
    expect(mergeNodes(shown.slice(0, 1), fresh()).map((n) => n.id)).toEqual(["note:N1", "note:N2"]);
  });
});

describe("mergeEdges", () => {
  it("keeps the shown edges (and their selection) when nothing changed", () => {
    const nodes = new Set(["note:N1", "task:T1"]);
    const shown = boardEdges([link({ id: "L1" })], nodes).map((e) => ({ ...e, selected: true }));
    expect(mergeEdges(shown, boardEdges([link({ id: "L1" })], nodes))).toBe(shown);
    expect(mergeEdges(shown, [])).toEqual([]);
  });
});

describe("items", () => {
  it("round-trips item keys", () => {
    expect(itemKey({ type: "task", id: "T1" })).toBe("task:T1");
    expect(parseItemKey("note:N1")).toEqual({ type: "note", id: "N1" });
    expect(parseItemKey("label:X")).toBeNull();
  });

  it("finds the other end of each link", () => {
    const links = [link({ id: "L1", a_type: "note", a_id: "N1", b_type: "task", b_id: "T1" }), link({ id: "L2", a_type: "task", a_id: "T1", b_type: "task", b_id: "T2" })];
    expect(linksOf({ type: "task", id: "T1" }, links).map((l) => l.other)).toEqual([
      { type: "note", id: "N1" },
      { type: "task", id: "T2" },
    ]);
  });

  it("searches titles and note text, every word, leaving out excluded items", () => {
    const items = {
      notes: new Map([["N1", note({ id: "N1", title: "Garden ideas", body: "plant lemon tree" })]]),
      tasks: new Map([
        ["T1", task({ id: "T1", title: "Buy lemon tree" })],
        ["T2", task({ id: "T2", title: "Water the lemon tree", status: "done" })],
      ]),
    };
    expect(searchItems("lemon tree", items, new Set()).map((m) => m.title)).toEqual(["Buy lemon tree", "Garden ideas", "Water the lemon tree"]);
    expect(searchItems("lemon", items, new Set(["task:T1"])).map((m) => m.ref.id)).toEqual(["N1", "T2"]);
    expect(searchItems("garden", items, new Set())).toEqual([{ ref: { type: "note", id: "N1" }, title: "Garden ideas" }]);
  });

  it("rebuilds an archived item from its history", () => {
    const events = [
      event({ seq: 1, entity_type: "task", entity_id: "T1", action: "create", after: { ...task({ id: "T1", title: "First" }), prov: undefined } }),
      event({ seq: 2, entity_type: "link", entity_id: "L1", action: "create", after: { id: "L1" } }),
      event({ seq: 3, entity_type: "task", entity_id: "T1", before: { title: "First" }, after: { title: "Second" } }),
      event({ seq: 4, entity_type: "task", entity_id: "T1", action: "archive", before: { archived_at: null }, after: { archived_at: "2026-10-14T10:00:00.000Z" } }),
    ];
    const row = asTask(rebuildRow({ type: "task", id: "T1" }, events));
    expect(row).toMatchObject({ id: "T1", title: "Second", archived_at: "2026-10-14T10:00:00.000Z", prov: null });
    expect(asNote(rebuildRow({ type: "task", id: "T1" }, events))).toBeNull();
    expect(rebuildRow({ type: "task", id: "T9" }, events)).toBeNull();
  });
});

describe("roundPosition", () => {
  it("stores whole pixels", () => {
    expect(roundPosition({ x: 10.4, y: -3.6 })).toEqual({ x: 10, y: -4 });
  });
});
