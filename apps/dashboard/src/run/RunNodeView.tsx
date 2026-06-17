import { Handle, Position, type NodeProps } from "@xyflow/react";
import { nodeMetaLine, nodeTypeLabel } from "../editor/graphMapping";
import { nodeTypeIcon } from "../editor/nodeTypeIcons";
import { ExpandIcon } from "../ui/icons";
import { SourceHandles } from "../editor/nodes/SourceHandles";
import type { RunFlowNode } from "./runView";

// Read-only node renderer for the run inspector and editor playback: a
// status-coloured left border (driven by the `data-status` attribute in CSS).
// It keeps the same info the editor node shows — type, id, title, and the
// agent_task's `profile · model` — and adds the run status on its OWN line, so
// starting a run augments the card rather than overwriting its info line. In
// an open button reveals the node-detail modal when `onSelect` is wired; both
// the run inspector and editor playback wire it, so a running node is
// inspectable from either (read-only in playback, alongside double-click open).
export function RunNodeView({ data, selected }: NodeProps<RunFlowNode>): React.ReactElement {
  const { node, status, approvalPending, onSelect } = data;
  const meta = nodeMetaLine(node);
  return (
    <div
      data-status={status ?? "none"}
      data-approval={approvalPending === true ? "pending" : undefined}
      className={`hw-node hw-node--run${selected ? " is-selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="hw-node__head">
        <div className="hw-node__type">
          {nodeTypeIcon(node.type)} {nodeTypeLabel(node.type)}{" "}
          <span className="hw-node__id">{node.id}</span>
        </div>
        {onSelect && (
          <button
            type="button"
            className="hw-node__open nodrag"
            aria-label={`Open node ${node.id}`}
            title="Open node"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(node.id);
            }}
          >
            <ExpandIcon />
          </button>
        )}
      </div>
      {node.title !== undefined && <div className="hw-node__title">{node.title}</div>}
      {meta !== "" && <div className="hw-node__meta">{meta}</div>}
      <div className="hw-node__status">
        {status ?? "—"}
        {approvalPending === true && (
          <span className="hw-node__approval" title="Waiting for command approval">
            {" "}
            ⏳
          </span>
        )}
      </div>
      <SourceHandles
        nodeType={node.type}
        usedHandles={(data.usedHandles as string[] | undefined) ?? []}
      />
    </div>
  );
}
