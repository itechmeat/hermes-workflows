import { Handle, Position } from "@xyflow/react";
import { sourceHandlesFor } from "../graphMapping";

// The outgoing branch points of a canvas node, anchored on the node's RIGHT
// EDGE and spread vertically, with a label just inside the edge. The handle an
// edge leaves from encodes its condition (see graphMapping.handleToEdgeData), so
// the branch cause is visible at the source: distinct labeled handles for a
// conditional branch, vs several edges out of the single `always` handle for a
// parallel fan-out.
//
// Anchoring on the edge (ReactFlow's default for a Right handle, kept here)
// matters: a handle inset into the card body makes the edge route under the card
// to reach it. Shared by the editor and run node views so an edge bound to a
// `sourceHandle` id attaches on both canvases; `labels=false` keeps the run
// canvas compact (handles still present for routing, just unlabeled).
export function SourceHandles({
  nodeType,
  labels = true,
}: {
  nodeType: string;
  labels?: boolean;
}): React.ReactElement | null {
  const handles = sourceHandlesFor(nodeType);
  if (handles.length === 0) return null;
  const n = handles.length;
  return (
    <>
      {handles.map((h, i) => {
        // Distribute the handles down the card's right edge.
        const top = `${Math.round(((i + 1) / (n + 1)) * 100)}%`;
        return (
          <span key={h.id} className="hw-node__handle-anchor">
            {labels && (
              <span className="hw-node__handle-label" style={{ top }}>
                {h.label}
              </span>
            )}
            <Handle
              type="source"
              id={h.id}
              position={Position.Right}
              className={`hw-handle hw-handle--${h.tone}`}
              style={{ top }}
            />
          </span>
        );
      })}
    </>
  );
}
