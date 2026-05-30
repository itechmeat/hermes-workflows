import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowNode } from "../graphMapping";

const TYPE_LABEL: Record<string, string> = {
  agent_task: "Agent task",
  condition: "Condition",
  human_review: "Human review",
  finish: "Finish",
};

// One generic renderer for every workflow node type (T3). It shows the type,
// id, and title and exposes a target/source handle so edges can be drawn;
// per-type detail editing lives in the inspector (T4).
export function WorkflowNodeView({ data, selected }: NodeProps<FlowNode>): React.ReactElement {
  const { node } = data;
  return (
    <div
      data-node-type={node.type}
      style={{
        minWidth: 140,
        padding: "8px 12px",
        borderRadius: 6,
        border: `1px solid ${selected ? "#5b9dd9" : "var(--border, #3a3a3a)"}`,
        background: "var(--card, #1d1d1d)",
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ opacity: 0.6, textTransform: "uppercase", fontSize: 10 }}>
        {TYPE_LABEL[node.type] ?? node.type}
      </div>
      <div style={{ fontWeight: 600 }}>{node.title ?? node.id}</div>
      {node.title !== undefined && <div style={{ opacity: 0.6 }}>{node.id}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
