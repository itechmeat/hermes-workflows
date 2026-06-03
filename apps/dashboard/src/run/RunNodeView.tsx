import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RunFlowNode } from "./runView";

// Read-only node renderer for the run inspector: a status-coloured left border
// (driven by the `data-status` attribute in CSS) and the current node status.
export function RunNodeView({ data, selected }: NodeProps<RunFlowNode>): React.ReactElement {
  const { node, status } = data;
  return (
    <div
      data-status={status ?? "none"}
      className={`hw-node hw-node--run${selected ? " is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="hw-node__title">{node.title ?? node.id}</div>
      <div className="hw-node__meta">{status ?? "—"}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
