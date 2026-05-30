import { Handle, Position, type NodeProps } from "@xyflow/react";
import { statusColor, type RunFlowNode } from "./runView";

// Read-only node renderer for the run inspector: a status-coloured left border
// and the current node status. `data-status` is exposed for tests/inspection.
export function RunNodeView({ data, selected }: NodeProps<RunFlowNode>): React.ReactElement {
  const { node, status } = data;
  const color = status ? statusColor(status) : "var(--border, #3a3a3a)";
  return (
    <div
      data-status={status ?? "none"}
      style={{
        minWidth: 140,
        padding: "8px 12px",
        borderRadius: 6,
        border: `1px solid ${selected ? "#5b9dd9" : "var(--border, #3a3a3a)"}`,
        borderLeft: `4px solid ${color}`,
        background: "var(--card, #1d1d1d)",
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600 }}>{node.title ?? node.id}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>{status ?? "—"}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
