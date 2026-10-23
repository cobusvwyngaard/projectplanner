import { describe, expect, it } from "vitest";
import { borderPoint, boardEdges, boardNodes, centreOf, mergeEdges, mergeNodes, nodeItem, roundPosition, type BoardNode } from "../../src/app/lib/board";
import { asNote, asTask, completionEvent, dueDateProblem, itemKey, linksOf, parseItemKey, rebuildRow, searchItems } from "../../src/app/lib/items";
import { OTHER, event, link, note, task } from "./app-fixtures";

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
    const first = link({ id: "L1", a_id: "N1", b_id: "T1" });
    const edges = boardEdges([first, link({ id: "L2", a_id: "N1", b_id: "T2" })], new Set(["note:N1", "task:T1"]));
    expect(edges).toEqual([
      {
        id: "link:L1",
        type: "link",
        source: "note:N1",
        target: "task:T1",
        data: { id: "L1", link: first, relation: "related", directionLabel: "Related link" },
        ariaLabel: "Related link",
      },
    ]);
  });

  it("points dependency arrows from the first task to the waiting task", () => {
    const ends = { a_type: "task", a_id: "T1", b_type: "task", b_id: "T2" } as const;
    const forward = link({ id: "L1", ...ends, direction: "a_to_b" });
    const backward = link({ id: "L2", ...ends, direction: "b_to_a" });
    const nodes = new Set(["task:T1", "task:T2"]);
    expect(boardEdges([forward, backward], nodes)).toEqual([
      {
        id: "link:L1",
        type: "link",
        source: "task:T1",
        target: "task:T2",
        data: {
          id: "L1",
          link: forward,
          relation: { before: { type: "task", id: "T1" }, after: { type: "task", id: "T2" } },
          directionLabel: "Dependency",
        },
        ariaLabel: "Dependency",
      },
      {
        id: "link:L2",
        type: "link",
        source: "task:T2",
        target: "task:T1",
        data: {
          id: "L2",
          link: backward,
          relation: { before: { type: "task", id: "T2" }, after: { type: "task", id: "T1" } },
          directionLabel: "Dependency",
        },
        ariaLabel: "Dependency",
      },
    ]);
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

describe("completionEvent", () => {
  const DONE_AT = "2026-10-14T09:00:00.000Z";
  const history = [
    event({ seq: 1, entity_type: "task", entity_id: "T1", action: "create", after: { title: "T", status: "open" } }),
    event({
      seq: 2,
      entity_type: "task",
      entity_id: "T1",
      action: "complete",
      actor_kind: "claude",
      actor_user_id: OTHER.id,
      run_id: "R1",
      after: { status: "done", done_at: DONE_AT, done_by_user_id: OTHER.id },
    }),
  ];

  it("finds the event that ticked the task off, with its actor (Claude, not the person)", () => {
    const found = completionEvent(task({ id: "T1", status: "done", done_at: DONE_AT, done_by_user_id: OTHER.id }), history);
    expect(found).toMatchObject({ seq: 2, actor_kind: "claude", actor_user_id: OTHER.id });
  });

  it("keeps the original tick when a reopen is reverted", () => {
    const reverted = [
      ...history,
      event({ seq: 3, entity_type: "task", entity_id: "T1", action: "reopen", after: { status: "open", done_at: null } }),
      event({ seq: 4, entity_type: "task", entity_id: "T1", action: "revert", after: { status: "done", done_at: DONE_AT } }),
    ];
    expect(completionEvent(task({ id: "T1", status: "done", done_at: DONE_AT }), reverted)?.seq).toBe(2);
  });

  it("is null for an open task or before the history has loaded", () => {
    expect(completionEvent(task({ id: "T1" }), history)).toBeNull();
    expect(completionEvent(task({ id: "T1", status: "done", done_at: DONE_AT }), [])).toBeNull();
  });
});

describe("dueDateProblem", () => {
  it("accepts a whole date from 1900 on, and an emptied field (clear)", () => {
    expect(dueDateProblem("2027-10-20", false)).toBeNull();
    expect(dueDateProblem("1900-01-01", false)).toBeNull();
    expect(dueDateProblem("", false)).toBeNull();
  });

  it("refuses half-typed years and dates with an empty part", () => {
    expect(dueDateProblem("0002-10-20", false)).toMatch(/year from 1900/);
    expect(dueDateProblem("0202-10-20", false)).toMatch(/year from 1900/);
    expect(dueDateProblem("2026-02-30", false)).toMatch(/whole date/);
    expect(dueDateProblem("", true)).toMatch(/finish the day, month and year/);
  });
});

describe("roundPosition", () => {
  it("stores whole pixels", () => {
    expect(roundPosition({ x: 10.4, y: -3.6 })).toEqual({ x: 10, y: -4 });
  });
});

describe("borderPoint", () => {
  const card = { x: 0, y: 0, width: 200, height: 100 };

  it("leaves through the side that faces the other card", () => {
    expect(borderPoint(card, { x: 500, y: 50 })).toEqual({ x: 200, y: 50 });
    expect(borderPoint(card, { x: -300, y: 50 })).toEqual({ x: 0, y: 50 });
    expect(borderPoint(card, { x: 100, y: 400 })).toEqual({ x: 100, y: 100 });
    expect(borderPoint(card, { x: 100, y: -400 })).toEqual({ x: 100, y: 0 });
  });

  it("follows the line between the centres to the corner region", () => {
    // Towards the lower right at 45°: the bottom edge is reached first.
    expect(borderPoint(card, { x: 300, y: 250 })).toEqual({ x: 150, y: 100 });
  });

  it("returns the centre when both centres coincide", () => {
    expect(borderPoint(card, centreOf(card))).toEqual({ x: 100, y: 50 });
  });
});
