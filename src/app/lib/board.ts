// Turning notes, placed tasks and links into React Flow nodes and edges, and
// merging fresh store data into the nodes React Flow is showing without
// disturbing a drag or resize in progress.

import type { Edge, Node, XYPosition } from "@xyflow/react";
import type { Id, ItemRef, Link, NoteView, TaskView } from "../../shared/types";
import { itemKey } from "./items";

export interface ItemNodeData extends Record<string, unknown> {
  id: Id;
}
export type NoteNode = Node<ItemNodeData, "note">;
export type TaskNode = Node<ItemNodeData, "task">;
export type BoardNode = NoteNode | TaskNode;

export interface LinkEdgeData extends Record<string, unknown> {
  id: Id;
}
export type LinkEdge = Edge<LinkEdgeData, "link">;

/** Width of a task card; tasks have no stored size (matches the Worker's placement). */
export const TASK_CARD_WIDTH = 220;

/** Node ids are item keys ("note:<id>"), so links map straight onto edges. */
export function boardNodes(notes: Iterable<NoteView>, tasks: Iterable<TaskView>): BoardNode[] {
  const nodes: BoardNode[] = [];
  for (const note of notes) {
    nodes.push({
      id: itemKey({ type: "note", id: note.id }),
      type: "note",
      position: { x: note.x, y: note.y },
      width: note.w,
      height: note.h,
      data: { id: note.id },
    });
  }
  for (const task of tasks) {
    if (task.x === null || task.y === null) continue;
    nodes.push({
      id: itemKey({ type: "task", id: task.id }),
      type: "task",
      position: { x: task.x, y: task.y },
      data: { id: task.id },
    });
  }
  return nodes;
}

/** Edges for links whose two items are both on the board. */
export function boardEdges(links: Iterable<Link>, nodeIds: ReadonlySet<string>): LinkEdge[] {
  const edges: LinkEdge[] = [];
  for (const link of links) {
    const source = itemKey({ type: link.a_type, id: link.a_id });
    const target = itemKey({ type: link.b_type, id: link.b_id });
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    edges.push({ id: `link:${link.id}`, type: "link", source, target, data: { id: link.id } });
  }
  return edges;
}

function samePlacement(a: BoardNode, b: BoardNode): boolean {
  return a.position.x === b.position.x && a.position.y === b.position.y && a.width === b.width && a.height === b.height;
}

/**
 * Fresh nodes from the store, merged into the nodes on screen: a node being
 * dragged or resized stays as the user has it; an unchanged node keeps its
 * object (so React Flow does not redraw it); a changed one keeps its
 * selection and measured size.
 */
export function mergeNodes(shown: readonly BoardNode[], fresh: readonly BoardNode[]): BoardNode[] {
  const byId = new Map(shown.map((n) => [n.id, n]));
  let changed = shown.length !== fresh.length;
  const merged = fresh.map((node, index) => {
    const prev = byId.get(node.id);
    let out: BoardNode = node;
    if (prev && (prev.dragging || prev.resizing || samePlacement(prev, node))) out = prev;
    else if (prev) {
      out = { ...node, selected: prev.selected ?? false } as BoardNode;
      if (prev.measured && prev.width === node.width && prev.height === node.height) out.measured = prev.measured;
    }
    if (out !== shown[index]) changed = true;
    return out;
  });
  return changed ? merged : (shown as BoardNode[]);
}

/** Fresh edges merged into the edges on screen, keeping selection. */
export function mergeEdges(shown: readonly LinkEdge[], fresh: readonly LinkEdge[]): LinkEdge[] {
  const byId = new Map(shown.map((e) => [e.id, e]));
  let changed = shown.length !== fresh.length;
  const merged = fresh.map((edge, index) => {
    const prev = byId.get(edge.id);
    const out = prev && prev.source === edge.source && prev.target === edge.target ? prev : edge;
    if (out !== shown[index]) changed = true;
    return out;
  });
  return changed ? merged : (shown as LinkEdge[]);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the line from the centre of `rect` towards `point` leaves the
 * rectangle. Links are drawn between these border points, so an edge always
 * joins the facing sides of its two cards wherever they are.
 */
export function borderPoint(rect: Rect, point: XYPosition): XYPosition {
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const centre = { x: rect.x + halfW, y: rect.y + halfH };
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

export function centreOf(rect: Rect): XYPosition {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Board coordinates are stored as whole pixels. */
export function roundPosition(position: XYPosition): XYPosition {
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

/** The item a node or edge end stands for. */
export function nodeItem(node: Pick<BoardNode, "type" | "data">): ItemRef {
  return { type: node.type === "note" ? "note" : "task", id: node.data.id };
}
