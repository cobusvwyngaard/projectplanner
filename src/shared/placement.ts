// Where cards sit on the board, shared by the Worker (placing a note nobody
// placed) and the app (keeping a new card clear of the others).

/** A card's rectangle on the board. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room a task card takes up on the canvas (tasks have no stored size). */
export const TASK_CARD = { w: 220, h: 100 } as const;
/** Space kept between cards. */
export const GAP = 40;
/** Rings of GAP-sized steps searched around a wanted spot (1200 px each way). */
const NEAR_RINGS = 30;

/** True when the two boxes overlap or are less than GAP apart. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/** Every note, and every task that is on the board, as a box. */
export function occupiedBoxes(
  notes: Iterable<{ x: number; y: number; w: number; h: number }>,
  tasks: Iterable<{ x: number | null; y: number | null }>,
): Box[] {
  const boxes: Box[] = [];
  for (const n of notes) boxes.push({ x: n.x, y: n.y, w: n.w, h: n.h });
  for (const t of tasks) if (t.x !== null && t.y !== null) boxes.push({ x: t.x, y: t.y, ...TASK_CARD });
  return boxes;
}

/**
 * The top-left corner nearest to `wanted` where a card of its size keeps
 * clear of every occupied box: `wanted` itself when it is free, else the
 * closest point of a GAP-spaced grid around it. Further out the board is
 * crowded anyway, and `wanted` is used as it is.
 */
export function nearestFreeSpot(wanted: Box, occupied: readonly Box[]): { x: number; y: number } {
  const free = (x: number, y: number) => !occupied.some((box) => overlaps({ x, y, w: wanted.w, h: wanted.h }, box));
  for (let ring = 0; ring <= NEAR_RINGS; ring++) {
    const spots: { x: number; y: number; d: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        spots.push({ x: wanted.x + i * GAP, y: wanted.y + j * GAP, d: i * i + j * j });
      }
    }
    // Nearest first; at equal distance below before above, right before left.
    spots.sort((a, b) => a.d - b.d || b.y - a.y || b.x - a.x);
    const spot = spots.find((s) => free(s.x, s.y));
    if (spot) return { x: spot.x, y: spot.y };
  }
  return { x: wanted.x, y: wanted.y };
}
