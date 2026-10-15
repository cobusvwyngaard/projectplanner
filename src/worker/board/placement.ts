// Where to put a new note when nobody chose a spot: the first free cell of a
// grid, left to right and top to bottom, that does not overlap any open note
// or placed task. If the grid is full, the note goes below everything.

import { GAP, occupiedBoxes, overlaps, type Box } from "../../shared/placement";
import { openNotes, openTasks } from "./queries";
import { LIMITS } from "./validation";

/** Size of a new note when none is given (the notes table defaults). */
export const DEFAULT_NOTE_SIZE = { w: 240, h: 160 } as const;
/** Cells tried per row and number of rows before giving up on the grid. */
export const GRID_COLUMNS = 6;
export const GRID_ROWS = 40;

/** A free position for a card of the given size among the occupied boxes. */
export function freeSpot(size: { w: number; h: number }, occupied: readonly Box[]): { x: number; y: number } {
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      const spot = { x: col * (size.w + GAP), y: row * (size.h + GAP), ...size };
      if (!occupied.some((r) => overlaps(spot, r))) return { x: spot.x, y: spot.y };
    }
  }
  const bottom = Math.max(...occupied.map((r) => r.y + r.h));
  return { x: 0, y: Math.min(bottom + GAP, LIMITS.coordinate) };
}

/** A free position on the board for a new note of the given size. */
export async function placeNote(db: D1Database, size: { w: number; h: number }): Promise<{ x: number; y: number }> {
  const [notes, tasks] = await Promise.all([openNotes(db), openTasks(db)]);
  return freeSpot(size, occupiedBoxes(notes, tasks));
}
