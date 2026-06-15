import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { ModelGroup, NodeType, SpecDetail, WorkflowNode } from "../api/types";
import { useFlowEditor, type SaveStatus } from "./useFlowEditor";
import { useRunPlayback, type PlaybackPhase } from "./useRunPlayback";
import { NodeInspector } from "./NodeInspector";
import { EdgeInspector } from "./EdgeInspector";
import { ValidationPanel } from "./ValidationPanel";
import { CompilePreview } from "./CompilePreview";
import { nodeTypeLabel, type FlowEdge, type FlowNode, type WorkflowEdgeData } from "./graphMapping";
import { nodeTypeIcon } from "./nodeTypeIcons";
import { NodeOpenProvider } from "./nodeOpenContext";
import { CANVAS_NODE_TYPES } from "../run/canvasNodeTypes";
import { CANVAS_EDGE_TYPES } from "./edges/canvasEdgeTypes";
import { overlayRunStatus } from "../run/runView";
import { Button, Menu, Modal, type MenuItem } from "../ui/components";
import { useHeaderSlots } from "../ui/PluginHeader";
import {
  ArrowLeftIcon,
  CopyIcon,
  FileIcon,
  LayoutIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "../ui/icons";

export interface FlowEditorProps {
  detail: SpecDetail;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  onSaved?: (saved: SpecDetail) => void;
  /** Navigate back to the workflows list (wired by the app shell). */
  onBack?: () => void;
  /** Navigate to the run inspector; enables the Play button when wired. */
  onOpenRun?: (runId: string) => void;
  /** Playback poll cadence override (tests). */
  pollMs?: number;
}

// Add-menu order. Labels come from the shared `nodeTypeLabel` mapping and icons
// from the shared `nodeTypeIcon` map (the same one the canvas nodes render), so
// the picker and a placed node stay visually consistent with no duplicate list.
const NODE_TYPES: NodeType[] = [
  "agent_task",
  "script",
  "condition",
  "human_review",
  "wait",
  "finish",
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

const PLAY_LABEL: Record<PlaybackPhase, string> = {
  attaching: "Play", // disabled until the mount active-run check lands
  idle: "Play",
  starting: "Starting…",
  playing: "Running…",
};

export function FlowEditor({
  detail,
  client,
  onSaved,
  onBack,
  onOpenRun,
  pollMs,
}: FlowEditorProps): React.ReactElement {
  const api = client ?? getApiClient();
  const ctrl = useFlowEditor(detail, api);
  const slots = useHeaderSlots();
  // Editing a node (the inspector modal) is separate from merely selecting it:
  // a single click selects (enables Duplicate, highlights), a double click or a
  // fresh add opens the editor.
  const [editing, setEditing] = useState(false);
  const [editingEdge, setEditingEdge] = useState(false);
  const [tool, setTool] = useState<Tool>(null);
  // Profile/model option lists for the inspector selects (the user's Hermes
  // roster + configured models). Best-effort: empty on failure.
  const [profiles, setProfiles] = useState<string[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [skills, setSkills] = useState<string[]>([]);

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
    api
      .listSkills()
      .then((s) => {
        if (active) setSkills(s);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);

  const handOff = useCallback(
    (runId: string) => {
      if (onOpenRun === undefined) {
        // Play is only rendered when navigation is wired; reaching this without
        // it is a wiring bug that must fail loudly, not strand the operator.
        throw new Error("FlowEditor playback requires the onOpenRun prop");
      }
      onOpenRun(runId);
    },
    [onOpenRun],
  );

  const playback = useRunPlayback({
    api,
    workflowId: detail.workflow.id,
    onHandOff: handOff,
    // Playback (incl. the mount attach check) exists only when the inspector
    // navigation is wired — same condition that renders the Play button.
    enabled: onOpenRun !== undefined,
    pollMs,
  });
  // Editing locks once a run is underway; the brief mount attach check does
  // not lock the canvas, it only holds the Play button.
  const playing = playback.phase === "starting" || playback.phase === "playing";

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

  const handlePlay = useCallback(async () => {
    // Run what the operator sees: a dirty graph is saved first, and a failed
    // save (already shown in the status label) aborts the start.
    if (ctrl.dirty) {
      const saved = await ctrl.save();
      if (saved === null) return;
      onSaved?.(saved);
    }
    playback.play();
  }, [ctrl, playback, onSaved]);

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

  // Clicking an edge opens its inspector (set its branch condition / fallback).
  const onEdgeClick = useCallback(
    (_event: unknown, edge: FlowEdge) => {
      ctrl.selectEdge(edge.id);
      setEditingEdge(true);
    },
    [ctrl],
  );

  const handleEdgeChange = useCallback(
    (data: WorkflowEdgeData) => {
      if (ctrl.selectedEdge) ctrl.updateEdge(ctrl.selectedEdge.id, data);
    },
    [ctrl],
  );

  const closeEdgeEditor = useCallback(() => {
    setEditingEdge(false);
    ctrl.selectEdge(null);
  }, [ctrl]);

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
    ctrl.selectEdge(null);
    setEditing(false);
    setEditingEdge(false);
  }, [ctrl]);

  // While a run plays the canvas renders the run pipeline: the same nodes at
  // their live positions, retyped for RunNodeView and tagged with run status.
  // Each run node carries `onSelect` so the operator can open it in a read-only
  // inspector mid-run (pure inspection; editing stays locked) - ReactFlow does
  // not pass React context into custom nodes, so the opener rides on node data.
  const canvasNodes =
    playing && playback.run !== null
      ? overlayRunStatus(ctrl.nodes, playback.run).map((node) => ({
          ...node,
          data: { ...node.data, onSelect: openNode },
        }))
      : ctrl.nodes;

  const addItems: MenuItem[] = NODE_TYPES.map((type) => ({
    key: type,
    label: nodeTypeLabel(type),
    icon: nodeTypeIcon(type),
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
      {onOpenRun !== undefined && (
        <Button
          variant="primary"
          // Held while the mount attach check runs (phase "attaching"), while
          // a run is underway, and while the pre-play save is in flight (so a
          // rapid double-click cannot queue a second save).
          disabled={playback.phase !== "idle" || ctrl.status.kind === "saving"}
          onClick={handlePlay}
        >
          <PlayIcon />
          {PLAY_LABEL[playback.phase]}
        </Button>
      )}
      <Menu
        label={
          <>
            <PlusIcon />
            Add node
          </>
        }
        items={addItems}
        disabled={playing}
      />
      <Button
        disabled={playing || !ctrl.dirty || ctrl.status.kind === "saving"}
        onClick={handleSave}
      >
        <SaveIcon />
        Save
      </Button>
      <Button disabled={playing || ctrl.selectedNode === null} onClick={handleDuplicate}>
        <CopyIcon />
        Duplicate node
      </Button>
      <Button disabled={playing} onClick={ctrl.applyLayout}>
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
        disabled={playing}
      />
      {playback.error !== null && (
        <span role="alert" className="hw-bar-status hw-error">
          {playback.error}
        </span>
      )}
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
                nodes={canvasNodes}
                edges={ctrl.edges}
                nodeTypes={CANVAS_NODE_TYPES}
                edgeTypes={CANVAS_EDGE_TYPES}
                nodesDraggable={!playing}
                nodesConnectable={!playing}
                elementsSelectable={!playing}
                onNodesChange={ctrl.onNodesChange}
                onEdgesChange={ctrl.onEdgesChange}
                onConnect={playing ? undefined : ctrl.onConnect}
                onMoveEnd={ctrl.onMoveEnd}
                onNodeClick={playing ? undefined : onNodeClick}
                onNodeDoubleClick={playing ? undefined : onNodeDoubleClick}
                onEdgeClick={playing ? undefined : onEdgeClick}
                onPaneClick={playing ? undefined : onPaneClick}
                defaultViewport={ctrl.viewport}
                fitView={ctrl.viewport === undefined}
                deleteKeyCode={playing ? null : ["Backspace", "Delete"]}
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
              {playing ? "Close" : "Done"}
            </Button>
          }
        >
          <NodeInspector
            node={ctrl.selectedNode}
            onChange={handleInspectorChange}
            profiles={profiles}
            modelGroups={modelGroups}
            skills={skills}
            // A running workflow opens nodes for inspection only: fully disabled
            // so the live run can never be edited from here.
            readOnly={playing}
          />
        </Modal>
      )}

      {editingEdge && ctrl.selectedEdge !== null && (
        <Modal
          title="Edge condition"
          ariaLabel="Edit edge condition"
          className="hw-node-modal"
          onClose={closeEdgeEditor}
          footer={
            <Button variant="primary" onClick={closeEdgeEditor}>
              {playing ? "Close" : "Done"}
            </Button>
          }
        >
          <EdgeInspector
            edge={ctrl.selectedEdge}
            nodeIds={ctrl.nodes.map((n) => n.id)}
            onChange={handleEdgeChange}
            readOnly={playing}
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
