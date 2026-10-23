// A link between two items, drawn as a straight line between the facing
// sides of the two cards (wherever they are). Dependencies show an arrow from
// the task that comes first to the waiting task.

import { BaseEdge, EdgeLabelRenderer, getStraightPath, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/react";
import { memo } from "react";
import { makeDependency, makeRelated, reverseDependency, unlink } from "../actions";
import { borderPoint, centreOf, type BoardNode, type LinkEdge, type Rect } from "../lib/board";
import { linkRelation } from "../lib/dependencies";
import { nodeItem } from "../lib/board";

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
  const link = data?.link;
  const rel = link ? linkRelation(link) : data?.relation;
  const depends = rel !== undefined && rel !== "related";
  const markerEnd = depends ? `url(#${id}-arrow)` : undefined;
  return (
    <>
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <marker
            id={`${id}-arrow`}
            markerWidth="12"
            markerHeight="8"
            refX="10"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L12,4 L0,8 z" className="edge-arrowhead" />
          </marker>
        </defs>
      </svg>
      <BaseEdge
        id={id}
        path={path}
        className={`link-edge${selected ? " link-edge--selected" : ""}${depends ? " link-edge--dependency" : ""}`}
        interactionWidth={24}
        markerEnd={markerEnd}
      />
      {selected && data && link && (
        <EdgeLabelRenderer>
          <div
            className="edge-toolbar nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            role="toolbar"
            aria-label="Link actions"
          >
            {rel !== undefined && rel !== "related" && (
              <button
                type="button"
                className="edge-action"
                onClick={() => void reverseDependency(link.id, rel.after, rel.before)}
              >
                Reverse
              </button>
            )}
            {depends ? (
              <button type="button" className="edge-action" onClick={() => void makeRelated(link.id)}>
                Make related
              </button>
            ) : (
              <button
                type="button"
                className="edge-action"
                onClick={() => {
                  const aRef = nodeItem(from);
                  const bRef = nodeItem(to);
                  void makeDependency(link.id, aRef, bRef);
                }}
              >
                Make dependency
              </button>
            )}
            <button type="button" className="edge-action edge-action--danger" onClick={() => void unlink(link.id)}>
              Remove
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
