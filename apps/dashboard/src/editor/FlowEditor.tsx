import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { ModelGroup, NodeType, SpecDetail, WorkflowNode } from "../api/types";
import { useFlowEditor, type SaveStatus } from "./useFlowEditor";
import { WorkflowNodeView } from "./nodes/WorkflowNodeView";
import { NodeInspector } from "./NodeInspector";
import { ValidationPanel } from "./ValidationPanel";
import { CompilePreview } from "./CompilePreview";
import { WORKFLOW_NODE_TYPE, nodeTypeLabel, type FlowNode } from "./graphMapping";
import { NodeOpenProvider } from "./nodeOpenContext";
import { Button, Menu, Modal, type MenuItem } from "../ui/components";
import { useHeaderSlots } from "../ui/PluginHeader";
import {
  ArrowLeftIcon,
  BranchIcon,
  CopyIcon,
  CpuIcon,
  EyeIcon,
  FileIcon,
  FlagIcon,
  LayoutIcon,
  PlusIcon,
  SaveIcon,
  ShieldCheckIcon,
  TerminalIcon,
  WrenchIcon,
} from "../ui/icons";

export interface FlowEditorProps {
  detail: SpecDetail;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  onSaved?: (saved: SpecDetail) => void;
  /** Navigate back to the workflows list (wired by the app shell). */
  onBack?: () => void;
}

// Labels come from the shared `nodeTypeLabel` mapping; only the icons live here.
const NODE_TYPES: { type: NodeType; icon: React.ReactNode }[] = [
  { type: "agent_task", icon: <CpuIcon /> },
  { type: "script", icon: <TerminalIcon /> },
  { type: "condition", icon: <BranchIcon /> },
  { type: "human_review", icon: <EyeIcon /> },
  { type: "finish", icon: <FlagIcon /> },
];

/** Which header-tool panel is open in a modal, if any. */
type Tool = "validate" | "compile" | null;

function statusLabel(status: SaveStatus, dirty: boolean): string {
  if (status.kind === "saving") return "Saving…";
  if (status.kind === "error") return `Save failed: ${status.message}`;
  if (dirty) return "Unsaved changes";
  if (status.kind === "saved") return "Saved";
  return "No changes";
}

export function FlowEditor({ detail, client, onSaved, onBack }: FlowEditorProps): React.ReactElement {
  const api = client ?? getApiClient();
  const ctrl = useFlowEditor(detail, api);
  const nodeTypes = useMemo(() => ({ [WORKFLOW_NODE_TYPE]: WorkflowNodeView }), []);
  const slots = useHeaderSlots();
  // Editing a node (the inspector modal) is separate from merely selecting it:
  // a single click selects (enables Duplicate, highlights), a double click or a
  // fresh add opens the editor.
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>(null);
  // Profile/model option lists for the inspector selects (the user's Hermes
  // roster + configured models). Best-effort: empty on failure.
  const [profiles, setProfiles] = useState<string[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);

  useEffect(() => {
    let active = true;
    api
      .listProfiles()
      .then((p) => {
        if (active) setProfiles(p);
      })
      .catch(() => {});
    api
      .listModels()
      .then((m) => {
        if (active) setModelGroups(m);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);

  const openNode = useCallback(
    (id: string) => {
      ctrl.selectNode(id);
      setEditing(true);
    },
    [ctrl],
  );

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

  const handleAdd = useCallback(
    (type: NodeType) => {
      ctrl.addNode(type);
      setEditing(true); // a new node opens straight into the editor
    },
    [ctrl],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: FlowNode) => ctrl.selectNode(node.id),
    [ctrl],
  );

  const onNodeDoubleClick = useCallback(
    (_event: unknown, node: FlowNode) => openNode(node.id),
    [openNode],
  );

  const handleDuplicate = useCallback(() => {
    if (ctrl.selectedNode) ctrl.duplicateNode(ctrl.selectedNode.id);
  }, [ctrl]);

  const closeEditor = useCallback(() => setEditing(false), []);
  const onPaneClick = useCallback(() => {
    ctrl.selectNode(null);
    setEditing(false);
  }, [ctrl]);

  const addItems: MenuItem[] = NODE_TYPES.map(({ type, icon }) => ({
    key: type,
    label: nodeTypeLabel(type),
    icon,
    onSelect: () => handleAdd(type),
  }));
  const toolItems: MenuItem[] = [
    { key: "validate", label: "Validation", icon: <ShieldCheckIcon />, onSelect: () => setTool("validate") },
    { key: "compile", label: "Compile preview", icon: <FileIcon />, onSelect: () => setTool("compile") },
  ];

  const title = (
    <>
      {onBack && (
        <Button size="sm" aria-label="Back" title="Back to workflows" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
      )}
      <span className="hw-bar-title">{detail.workflow.name}</span>
    </>
  );
  const actions = (
    <>
      <Menu
        label={
          <>
            <PlusIcon />
            Add node
          </>
        }
        items={addItems}
      />
      <Button disabled={!ctrl.dirty || ctrl.status.kind === "saving"} onClick={handleSave}>
        <SaveIcon />
        Save
      </Button>
      <Button disabled={ctrl.selectedNode === null} onClick={handleDuplicate}>
        <CopyIcon />
        Duplicate node
      </Button>
      <Button onClick={ctrl.applyLayout}>
        <LayoutIcon />
        Auto-layout
      </Button>
      <Menu
        label={
          <>
            <WrenchIcon />
            Tools
          </>
        }
        items={toolItems}
      />
      <span role="status" className="hw-bar-status">
        {statusLabel(ctrl.status, ctrl.dirty)}
      </span>
    </>
  );

  return (
    <>
      {slots ? (
        <>
          {slots.leftHost ? createPortal(title, slots.leftHost) : null}
          {slots.actionsHost ? createPortal(actions, slots.actionsHost) : null}
        </>
      ) : (
        <div className="hw-editor-toolbar">
          {title}
          {actions}
        </div>
      )}

      <div className="hw-shell">
        <div className="hw-editor-body">
          <div className="hw-canvas">
            <NodeOpenProvider value={openNode}>
              <ReactFlow
                nodes={ctrl.nodes}
                edges={ctrl.edges}
                nodeTypes={nodeTypes}
                onNodesChange={ctrl.onNodesChange}
                onEdgesChange={ctrl.onEdgesChange}
                onConnect={ctrl.onConnect}
                onMoveEnd={ctrl.onMoveEnd}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onPaneClick={onPaneClick}
                defaultViewport={ctrl.viewport}
                fitView={ctrl.viewport === undefined}
                deleteKeyCode={["Backspace", "Delete"]}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls />
              </ReactFlow>
            </NodeOpenProvider>
          </div>
        </div>
      </div>

      {editing && ctrl.selectedNode !== null && (
        <Modal
          title={nodeTypeLabel(ctrl.selectedNode.data.node.type)}
          ariaLabel={`Edit ${nodeTypeLabel(ctrl.selectedNode.data.node.type)}`}
          className="hw-node-modal"
          onClose={closeEditor}
          footer={
            <Button variant="primary" onClick={closeEditor}>
              Done
            </Button>
          }
        >
          <NodeInspector
            node={ctrl.selectedNode}
            onChange={handleInspectorChange}
            profiles={profiles}
            modelGroups={modelGroups}
          />
        </Modal>
      )}

      {tool === "validate" && (
        <Modal title="Validation" onClose={() => setTool(null)}>
          <ValidationPanel workflowId={detail.workflow.id} client={api} />
        </Modal>
      )}
      {tool === "compile" && (
        <Modal title="Compile preview" onClose={() => setTool(null)}>
          <CompilePreview workflowId={detail.workflow.id} client={api} />
        </Modal>
      )}
    </>
  );
}
