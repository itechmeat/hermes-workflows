import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { FlowEdge } from "../graphMapping";
import { edgeConditionLabel, edgeTone } from "../graphMapping";

// The canvas edge. A plain edge is neutral and unlabeled (a parallel fan-out);
// a conditioned edge carries a colored label of its branch cause (success /
// failure / a review decision / "else"), and a fallback is drawn dashed - so a
// branch is distinguishable from a fan-out at a glance.
export function WorkflowEdgeView(props: EdgeProps<FlowEdge>): React.ReactElement {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    source,
    markerEnd,
    selected,
  } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const tone = edgeTone(data);
  const label = edgeConditionLabel(data, source);
  const hovered = data?.hovered === true;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        className={`hw-edge hw-edge--${tone}${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}`}
        style={tone === "else" ? { strokeDasharray: "6 4" } : undefined}
      />
      {label !== "" && (
        <EdgeLabelRenderer>
          <div
            className={`hw-edge-label hw-edge-label--${tone} nodrag nopan`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
