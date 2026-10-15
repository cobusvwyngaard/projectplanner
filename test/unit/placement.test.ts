import { describe, expect, it } from "vitest";
import { GAP, TASK_CARD, nearestFreeSpot, occupiedBoxes, overlaps } from "../../src/shared/placement";

const NOTE = { w: 240, h: 160 };

describe("nearestFreeSpot", () => {
  it("keeps the wanted spot when it is free", () => {
    expect(nearestFreeSpot({ x: 100, y: 50, ...NOTE }, [{ x: 600, y: 600, ...NOTE }])).toEqual({ x: 100, y: 50 });
  });

  it("moves a card added at the same spot clear of the first, as close as it can", () => {
    const first = { x: 290, y: 171, ...NOTE };
    const second = nearestFreeSpot(first, [first]);
    expect(overlaps({ ...second, ...NOTE }, first)).toBe(false);
    // Below the first note (160 + GAP), which is nearer than beside it (240 + GAP).
    expect(second).toEqual({ x: 290, y: 171 + NOTE.h + GAP });
    const third = nearestFreeSpot(first, [first, { ...second, ...NOTE }]);
    expect(overlaps({ ...third, ...NOTE }, first)).toBe(false);
    expect(overlaps({ ...third, ...NOTE }, { ...second, ...NOTE })).toBe(false);
  });

  it("keeps a new task off a note in the middle of the view", () => {
    const note = { x: 0, y: 0, ...NOTE };
    const spot = nearestFreeSpot({ x: 10, y: 50, ...TASK_CARD }, [note]);
    expect(overlaps({ ...spot, ...TASK_CARD }, note)).toBe(false);
  });
});

describe("occupiedBoxes", () => {
  it("counts every note and only the tasks on the board, at task-card size", () => {
    const boxes = occupiedBoxes([{ x: 1, y: 2, w: 300, h: 200 }], [{ x: 5, y: 6 }, { x: null, y: null }]);
    expect(boxes).toEqual([
      { x: 1, y: 2, w: 300, h: 200 },
      { x: 5, y: 6, ...TASK_CARD },
    ]);
  });
});
