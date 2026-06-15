import { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { nextAddableHandleId, shownHandleSpecs, type SourceHandleKind } from "../graphMapping";

// The outgoing branch points of a canvas node, anchored on the node's RIGHT
// EDGE and spread vertically. The handle an edge leaves from encodes its
// condition (see graphMapping.handleToEdgeData), so the branch cause is visible
// at the source. No text labels: the dot's color carries the meaning (success
// green, failure red, the rest neutral), and the handles are absolutely
// positioned so they never push or resize the node's content.
//
// A node shows its two primary outcomes by default (success/failure, or a
// review's approved/rejected); the "+" affordance (editor only, on hover) adds
// the next unused outcome and disables once every outcome is shown, so a handle
// can never be added twice. Handles already used by an edge are always shown
// (passed in `usedHandles`) so an existing conditioned/fallback/plain edge stays
// anchored - which also keeps run-canvas edges attached.
export function SourceHandles({
  nodeType,
  usedHandles = [],
  editable = false,
}: {
  nodeType: string;
  usedHandles?: string[];
  editable?: boolean;
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
      {handles.map((h, i) => (
        <Handle
          key={h.id}
          type="source"
          id={h.id}
          position={Position.Right}
          className={`hw-handle hw-handle--${h.tone}`}
          // Distribute the handles down the card's right edge.
          style={{ top: `${Math.round(((i + 1) / (n + 1)) * 100)}%` }}
        />
      ))}
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
