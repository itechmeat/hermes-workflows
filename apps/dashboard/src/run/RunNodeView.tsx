import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { RunFlowNode } from "./runView";

// Read-only node renderer for the run inspector: a status-coloured left border
// (driven by the `data-status` attribute in CSS), the current node status, and
// a waiting badge while the node's worker is blocked on a command approval.
export function RunNodeView({ data, selected }: NodeProps<RunFlowNode>): React.ReactElement {
  const { node, status, approvalPending } = data;
  return (
    <div
      data-status={status ?? "none"}
      data-approval={approvalPending === true ? "pending" : undefined}
      className={`hw-node hw-node--run${selected ? " is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="hw-node__title">{node.title ?? node.id}</div>
      <div className="hw-node__meta">
        {status ?? "—"}
        {approvalPending === true && (
          <span className="hw-node__approval" title="Waiting for command approval">
            {" "}
            ⏳
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
