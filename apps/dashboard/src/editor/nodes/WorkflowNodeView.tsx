import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowNode } from "../graphMapping";
import { nodeMetaLine, nodeTypeLabel } from "../graphMapping";
import { nodeTypeIcon } from "../nodeTypeIcons";
import { useNodeOpen } from "../nodeOpenContext";
import { ExpandIcon } from "../../ui/icons";
import { SourceHandles } from "./SourceHandles";

// One generic renderer for every workflow node type. The header line carries
// the human type label and a short id; an open button (equivalent to a double
// click) reveals the editor modal. agent_task nodes show profile · model under
// the title.
export function WorkflowNodeView({ data, selected }: NodeProps<FlowNode>): React.ReactElement {
  const { node } = data;
  const openNode = useNodeOpen();
  const meta = nodeMetaLine(node);

  return (
    <div data-node-type={node.type} className={`hw-node${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="hw-node__head">
        <div className="hw-node__type">
          {nodeTypeIcon(node.type)} {nodeTypeLabel(node.type)}{" "}
          <span className="hw-node__id">{node.id}</span>
        </div>
        {openNode && (
          <button
            type="button"
            className="hw-node__open nodrag"
            aria-label="Open node"
            title="Open node"
            onClick={(e) => {
              e.stopPropagation();
              openNode(node.id);
            }}
          >
            <ExpandIcon />
          </button>
        )}
      </div>
      {node.title !== undefined && <div className="hw-node__title">{node.title}</div>}
      {meta !== "" && <div className="hw-node__meta">{meta}</div>}
      <SourceHandles
        nodeType={node.type}
        usedHandles={(data.usedHandles as string[] | undefined) ?? []}
        editable={data.branchEditable === true}
      />
    </div>
  );
}
