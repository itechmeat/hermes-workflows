import { useCallback, useMemo } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { SpecDetail, WorkflowNode } from "../api/types";
import { useFlowEditor, type SaveStatus } from "./useFlowEditor";
import { WorkflowNodeView } from "./nodes/WorkflowNodeView";
import { NodePalette } from "./NodePalette";
import { NodeInspector } from "./NodeInspector";
import { ValidationPanel } from "./ValidationPanel";
import { CompilePreview } from "./CompilePreview";
import { WORKFLOW_NODE_TYPE, type FlowNode } from "./graphMapping";

export interface FlowEditorProps {
  detail: SpecDetail;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  onSaved?: (saved: SpecDetail) => void;
}

function statusLabel(status: SaveStatus, dirty: boolean): string {
  if (status.kind === "saving") return "Saving…";
  if (status.kind === "error") return `Save failed: ${status.message}`;
  if (dirty) return "Unsaved changes";
  if (status.kind === "saved") return "Saved";
  return "No changes";
}

export function FlowEditor({ detail, client, onSaved }: FlowEditorProps): React.ReactElement {
  const api = client ?? getApiClient();
  const ctrl = useFlowEditor(detail, api);
  const nodeTypes = useMemo(() => ({ [WORKFLOW_NODE_TYPE]: WorkflowNodeView }), []);

  const handleSave = useCallback(async () => {
    const saved = await ctrl.save();
    if (saved) onSaved?.(saved);
  }, [ctrl, onSaved]);

  const handleInspectorChange = useCallback(
    (patch: Partial<WorkflowNode>) => {
      if (ctrl.selectedNode) ctrl.updateNode(ctrl.selectedNode.id, patch);
    },
    [ctrl],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: FlowNode) => ctrl.selectNode(node.id),
    [ctrl],
  );

  const handleDuplicate = useCallback(() => {
    if (ctrl.selectedNode) ctrl.duplicateNode(ctrl.selectedNode.id);
  }, [ctrl]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 8 }}>
        <strong>{detail.workflow.name}</strong>
        <button
          type="button"
          disabled={!ctrl.dirty || ctrl.status.kind === "saving"}
          onClick={handleSave}
        >
          Save
        </button>
        <button type="button" disabled={ctrl.selectedNode === null} onClick={handleDuplicate}>
          Duplicate node
        </button>
        <span role="status">{statusLabel(ctrl.status, ctrl.dirty)}</span>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 400 }}>
        <NodePalette onAdd={ctrl.addNode} />
        <div style={{ flex: 1, minHeight: 400 }}>
          <ReactFlow
            nodes={ctrl.nodes}
            edges={ctrl.edges}
            nodeTypes={nodeTypes}
            onNodesChange={ctrl.onNodesChange}
            onEdgesChange={ctrl.onEdgesChange}
            onConnect={ctrl.onConnect}
            onMoveEnd={ctrl.onMoveEnd}
            onNodeClick={onNodeClick}
            onPaneClick={() => ctrl.selectNode(null)}
            defaultViewport={ctrl.viewport}
            fitView={ctrl.viewport === undefined}
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <NodeInspector node={ctrl.selectedNode} onChange={handleInspectorChange} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", borderTop: "1px solid var(--border, #2a2a2a)" }}>
        <ValidationPanel workflowId={detail.workflow.id} client={api} />
        <CompilePreview workflowId={detail.workflow.id} client={api} />
      </div>
    </div>
  );
}
