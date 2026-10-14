// Where to put a new note when nobody chose a spot: the first free cell of a
// grid, left to right and top to bottom, that does not overlap any open note
// or placed task. If the grid is full, the note goes below everything.

import { openNotes, openTasks } from "./queries";
import { LIMITS } from "./validation";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Size of a new note when none is given (the notes table defaults). */
export const DEFAULT_NOTE_SIZE = { w: 240, h: 160 } as const;
/** Room a task card takes up on the canvas (tasks have no stored size). */
export const TASK_CARD = { w: 220, h: 100 } as const;
/** Space kept between cards. */
export const GAP = 40;
/** Cells tried per row and number of rows before giving up on the grid. */
export const GRID_COLUMNS = 6;
export const GRID_ROWS = 40;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/** A free position for a card of the given size among the occupied rectangles. */
export function freeSpot(size: { w: number; h: number }, occupied: readonly Rect[]): { x: number; y: number } {
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      const spot = { x: col * (size.w + GAP), y: row * (size.h + GAP), ...size };
      if (!occupied.some((r) => overlaps(spot, r))) return { x: spot.x, y: spot.y };
    }
  }
  const bottom = Math.max(...occupied.map((r) => r.y + r.h));
  return { x: 0, y: Math.min(bottom + GAP, LIMITS.coordinate) };
}

/** The rectangles of every open note and every placed open task. */
export async function occupiedRects(db: D1Database): Promise<Rect[]> {
  const [notes, tasks] = await Promise.all([openNotes(db), openTasks(db)]);
  const rects: Rect[] = notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  for (const t of tasks) {
    if (t.x !== null && t.y !== null) rects.push({ x: t.x, y: t.y, ...TASK_CARD });
  }
  return rects;
}

/** A free position on the board for a new note of the given size. */
export async function placeNote(db: D1Database, size: { w: number; h: number }): Promise<{ x: number; y: number }> {
  return freeSpot(size, await occupiedRects(db));
}
