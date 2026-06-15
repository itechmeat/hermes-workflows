import { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { nextAddableHandleId, shownHandleSpecs, type SourceHandleKind } from "../graphMapping";

// The outgoing branch points of a canvas node, anchored on the node's RIGHT
// EDGE and spread vertically, with a label just inside the edge. The handle an
// edge leaves from encodes its condition (see graphMapping.handleToEdgeData), so
// the branch cause is visible at the source.
//
// A node shows its two primary outcomes by default (success/failure, or a
// review's approved/rejected); the "+" affordance (editor only, on hover) adds
// the next unused outcome and disables once every outcome is shown, so a handle
// can never be added twice. Handles already used by an edge are always shown
// (passed in `usedHandles`) so an existing conditioned/fallback/plain edge stays
// anchored - which also keeps run-canvas edges attached.
//
// Anchoring on the edge (ReactFlow's default for a Right handle) matters: a
// handle inset into the card body makes the edge route under the card to reach
// it. Shared by the editor and run node views; `labels=false`/`editable=false`
// keep the run canvas compact and read-only.
export function SourceHandles({
  nodeType,
  usedHandles = [],
  editable = false,
  labels = true,
}: {
  nodeType: string;
  usedHandles?: string[];
  editable?: boolean;
  labels?: boolean;
}): React.ReactElement | null {
  const [added, setAdded] = useState<SourceHandleKind[]>([]);
  const handles = shownHandleSpecs(nodeType, usedHandles, added);
  if (handles.length === 0) return null;
  const n = handles.length;
  const nextAddable = nextAddableHandleId(
    nodeType,
    handles.map((h) => h.id),
  );
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
      {editable && (
        <button
          type="button"
          className="hw-node__add-handle nodrag"
          aria-label="Add branch point"
          title={nextAddable ? `Add ${nextAddable} branch point` : "All branch points shown"}
          disabled={nextAddable === null}
          onClick={(e) => {
            e.stopPropagation();
            if (nextAddable !== null) setAdded((a) => [...a, nextAddable]);
          }}
        >
          +
        </button>
      )}
    </>
  );
}
