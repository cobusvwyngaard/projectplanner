// A link between two items, drawn as a straight line between the facing
// sides of the two cards (wherever they are). When selected it offers an
// Unlink button; Delete or Backspace works too.

import { BaseEdge, EdgeLabelRenderer, getStraightPath, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/react";
import { memo } from "react";
import { unlink } from "../actions";
import { borderPoint, centreOf, type BoardNode, type LinkEdge, type Rect } from "../lib/board";

function rectOf(node: InternalNode<BoardNode>): Rect {
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, width: node.measured.width ?? 0, height: node.measured.height ?? 0 };
}

export const LinkEdgeView = memo(function LinkEdgeView({ id, source, target, data, selected }: EdgeProps<LinkEdge>) {
  const from = useInternalNode<BoardNode>(source);
  const to = useInternalNode<BoardNode>(target);
  if (!from || !to) return null;
  const a = rectOf(from);
  const b = rectOf(to);
  const start = borderPoint(a, centreOf(b));
  const end = borderPoint(b, centreOf(a));
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  return (
    <>
      <BaseEdge id={id} path={path} className={`link-edge${selected ? " link-edge--selected" : ""}`} interactionWidth={24} />
      {selected && data && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="edge-unlink nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => void unlink(data.id)}
          >
            Unlink
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
