import { Handle, Position } from "@xyflow/react";
import { sourceHandlesFor } from "../graphMapping";

// The outgoing branch points of a canvas node, rendered as a right-side column
// of labeled source handles. The handle an edge leaves from encodes its
// condition (see graphMapping.handleToEdgeData), so the branch cause is visible
// at the source: distinct labeled handles for a conditional branch, vs several
// edges out of the single `always` handle for a parallel fan-out.
//
// Shared by the editor node view and the run node view so an edge bound to a
// `sourceHandle` id attaches on both canvases. `labels=false` keeps the run
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
  return (
    <div className="hw-node__handles" data-labels={labels ? "on" : "off"}>
      {handles.map((h) => (
        <div key={h.id} className={`hw-node__handle hw-node__handle--${h.tone}`}>
          {labels && <span className="hw-node__handle-label">{h.label}</span>}
          <Handle
            type="source"
            id={h.id}
            position={Position.Right}
            className={`hw-handle hw-handle--${h.tone}`}
          />
        </div>
      ))}
    </div>
  );
}
