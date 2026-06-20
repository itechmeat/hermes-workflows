import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  hoverEdge,
  nodeTypeLabel,
  type FlowEdge,
  type FlowNode,
  type WorkflowEdgeData,
} from "./graphMapping";
import { nodeTypeIcon } from "./nodeTypeIcons";
import { NodeOpenProvider } from "./nodeOpenContext";
import { CANVAS_NODE_TYPES } from "../run/canvasNodeTypes";
import { CANVAS_EDGE_TYPES } from "./edges/canvasEdgeTypes";
import { overlayRunStatus } from "../run/runView";
import { RunLogPanel } from "../run/RunLogPanel";
import { deriveRunLogEvents, mergeRunLog, type LoggedRunEvent } from "../run/runLog";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Menu,
  Modal,
  Select,
  Textarea,
  ToastHost,
  useToasts,
  type MenuItem,
} from "../ui/components";
import type { WorkflowParam, ParamValue } from "@hermes-workflows/core/templates/params.ts";
import { useHeaderSlots } from "../ui/PluginHeader";
import {
  ArrowLeftIcon,
  CopyIcon,
  FileIcon,
  LayoutIcon,
  PlayIcon,
  PromptIcon,
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
  "prompt",
  "script",
  "condition",
  "human_review",
  "wait",
  "finish",
];

/** Which header-tool panel is open in a modal, if any. */
type Tool = "validate" | "compile" | null;

// Surfaces a failed save as a prominent, dismissible toast (the inline bar
// label is easy to miss). The message is the core's human-readable validation
// reason - e.g. "incomplete_branch: node 'collect' branches on node_status but
// covers neither outcome" - so the operator sees what and where without opening
// the Validate panel. Rendered inside <ToastHost>, where useToasts() resolves.
function SaveErrorToast({ status }: { status: SaveStatus }): null {
  const toasts = useToasts();
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (status.kind !== "error") {
      shownFor.current = null;
      return;
    }
    if (shownFor.current === status.message) return; // same failure, one toast
    shownFor.current = status.message;
    toasts.add({
      title: "Save failed",
      description: status.message,
      type: "save-error",
      priority: "high",
      timeout: 0, // an error stays until the operator dismisses it
      data: { testId: "save-error-toast" },
    });
  }, [status, toasts]);
  return null;
}

// Surfaces a run start / poll / attach failure as a toast - the editor header
// no longer carries an inline error. The toast is closed when the error clears
// (a self-healing poll failure disappears on the next good poll) and replaced
// when a different message arrives, so at most one run-error toast is shown.
function PlaybackErrorToast({ error }: { error: string | null }): null {
  const toasts = useToasts();
  const idRef = useRef<string | null>(null);
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (error === null) {
      if (idRef.current !== null) {
        toasts.close(idRef.current);
        idRef.current = null;
      }
      shownFor.current = null;
      return;
    }
    if (shownFor.current === error) return; // same message, one toast
    shownFor.current = error;
    if (idRef.current !== null) toasts.close(idRef.current);
    idRef.current = toasts.add({
      title: "Run error",
      description: error,
      type: "error",
      priority: "high",
      timeout: 0, // an error stays until it self-heals or the operator dismisses it
      data: { testId: "playback-error-toast" },
    });
  }, [error, toasts]);
  return null;
}

const PLAY_LABEL: Record<PlaybackPhase, string> = {
  attaching: "Play", // disabled until the mount active-run check lands
  idle: "Play",
  starting: "Starting…",
  playing: "Running…",
};

/** Initial form values for a template's params: the declared default rendered as
 *  a string (the controlled inputs are string-backed; the core coerces on run). */
function initialParamValues(params: WorkflowParam[]): Record<string, string> {
  return Object.fromEntries(
    params.map((p) => {
      if (p.default !== undefined) return [p.name, String(p.default)];
      // A bool always has a concrete value: an unchecked box means `false`, not
      // "unset", so it never trips the required-empty check.
      return [p.name, p.type === "bool" ? "false" : ""];
    }),
  );
}

/** One field per declared template param, rendered natively from the param's
 *  type (enum -> select, bool -> checkbox, int/text -> input). Controlled by a
 *  string-valued map; the core validates and coerces the values at run-create
 *  (a bad value surfaces as a start error), so the form stays a thin collector. */
function RunParamFields({
  params,
  values,
  onChange,
}: {
  params: WorkflowParam[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}): React.ReactElement {
  return (
    <>
      {params.map((param) => {
        const id = `hw-param-${param.name}`;
        const label = param.optional ? `${param.label} (optional)` : param.label;
        const options = param.options ?? [];
        return (
          <Field key={param.name} label={label} htmlFor={id}>
            {param.type === "enum" && options.length > 0 ? (
              <Select
                value={values[param.name] ?? ""}
                onValueChange={(v) => onChange(param.name, v)}
                items={options.map((o) => ({ value: o, label: o }))}
                placeholder="Select…"
              />
            ) : param.type === "bool" ? (
              <Checkbox
                checked={values[param.name] === "true"}
                onCheckedChange={(on) => onChange(param.name, on ? "true" : "false")}
                aria-label={param.label}
              />
            ) : (
              <Input
                id={id}
                type={param.type === "int" ? "number" : "text"}
                value={values[param.name] ?? ""}
                onChange={(e) => onChange(param.name, e.target.value)}
              />
            )}
            {param.help !== undefined && param.help !== "" && (
              <p className="hw-note">{param.help}</p>
            )}
          </Field>
        );
      })}
    </>
  );
}

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
  // The edge the pointer is over, for the blue hover highlight + lift-above-
  // nodes. Kept here (not in the edge model) so hover never dirties the graph.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  // The optional run-wide operator directive and the modal that captures it.
  // Layered above every agent_task prompt at highest priority for the run it
  // starts (the same directive the `/workflow run --input` CLI supplies); the
  // plain Play button starts with no input.
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [runInput, setRunInput] = useState("");
  // Template params declared on the workflow: when present, the run modal renders
  // a field per param. The core validates and coerces the values at run-create
  // (and substitutes them as {{params.X}}); the form only collects them.
  const declaredParams = useMemo(() => detail.workflow.params ?? [], [detail.workflow.params]);
  const hasParams = declaredParams.length > 0;
  const [runParamValues, setRunParamValues] = useState<Record<string, string>>(() =>
    initialParamValues(declaredParams),
  );
  const [paramError, setParamError] = useState<string | null>(null);
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

  // The curated, timestamped run log - the same panel the Runs inspector shows -
  // surfaces during playback, derived from the polled run state. Reset when the
  // playing run changes so a new run does not inherit the prior run's entries.
  const playbackRun = playback.run;
  const [runLog, setRunLog] = useState<LoggedRunEvent[]>([]);
  useEffect(() => {
    setRunLog([]);
  }, [playbackRun?.run_id]);
  useEffect(() => {
    if (playbackRun === null) return;
    setRunLog((prev) => mergeRunLog(prev, deriveRunLogEvents(playbackRun), Date.now()));
  }, [playbackRun]);

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

  const handlePlay = useCallback(
    async (input?: string, params?: Record<string, ParamValue>) => {
      // Run what the operator sees: a dirty graph is saved first, and a failed
      // save (already shown in the status label) aborts the start.
      if (ctrl.dirty) {
        const saved = await ctrl.save();
        if (saved === null) return;
        onSaved?.(saved);
      }
      playback.play(input, params);
    },
    [ctrl, playback, onSaved],
  );

  // Start from the run modal: a light required-presence check catches an empty
  // required field inline (the core still does the authoritative type/enum
  // validation at run-create and surfaces a bad value as a start error). Carry
  // the typed directive + collected param values into the run, then close the
  // modal. The field values are kept so a refused start can be retried.
  const handleRunWithInput = useCallback(() => {
    let params: Record<string, ParamValue> | undefined;
    if (hasParams) {
      const missing = declaredParams.filter(
        (p) => p.optional !== true && (runParamValues[p.name] ?? "").trim() === "",
      );
      if (missing.length > 0) {
        setParamError(`Fill required: ${missing.map((p) => p.label).join(", ")}`);
        return;
      }
      // Send only DECLARED params with a non-empty value: keying off the schema
      // (not the raw state map) prunes any stale value left over from a param
      // that was since renamed or removed. The core coerces strings to the
      // declared types; an omitted optional uses its default.
      const entries = declaredParams
        .map((p) => [p.name, runParamValues[p.name] ?? ""] as const)
        .filter(([, v]) => v.trim() !== "");
      params = entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    setParamError(null);
    setRunInputOpen(false);
    void handlePlay(runInput, params);
  }, [hasParams, declaredParams, runParamValues, handlePlay, runInput]);

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
  // Which source handles each node uses (by an outgoing edge), so a node always
  // renders the handles its edges leave from - keeping conditioned/fallback/plain
  // edges anchored even when they are not in the default success/failure pair.
  const usedHandlesByNode = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const edge of ctrl.edges) {
      (map[edge.source] ??= []).push(edge.sourceHandle ?? "out");
    }
    return map;
  }, [ctrl.edges]);

  const canvasNodes = (
    playing && playback.run !== null
      ? overlayRunStatus(ctrl.nodes, playback.run).map((node) => ({
          ...node,
          data: { ...node.data, onSelect: openNode },
        }))
      : ctrl.nodes
  ).map((node) => ({
    ...node,
    data: {
      ...node.data,
      usedHandles: usedHandlesByNode[node.id] ?? [],
      // The "+" add-branch affordance is editor-only; a playing run is read-only.
      branchEditable: !playing,
    },
  }));

  // Render-time hover overlay: the pointed-at edge turns blue and lifts above
  // the nodes layer, leaving the persisted edge model (ctrl.edges) untouched.
  const canvasEdges = useMemo(
    () => hoverEdge(ctrl.edges, hoveredEdgeId),
    [ctrl.edges, hoveredEdgeId],
  );
  const onEdgeMouseEnter = useCallback(
    (_event: unknown, edge: FlowEdge) => setHoveredEdgeId(edge.id),
    [],
  );
  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

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
        <>
          <Button
            variant="primary"
            // Held while the mount attach check runs (phase "attaching"), while
            // a run is underway, and while the pre-play save is in flight (so a
            // rapid double-click cannot queue a second save).
            disabled={playback.phase !== "idle" || ctrl.status.kind === "saving"}
            // A parameterized workflow must collect its param values first, so
            // Play opens the run modal; otherwise it is a bare start with no
            // operator input. The () wrapper drops the click event so it is
            // never mistaken for the input directive.
            onClick={() => (hasParams ? setRunInputOpen(true) : void handlePlay())}
          >
            <PlayIcon />
            {PLAY_LABEL[playback.phase]}
          </Button>
          {!hasParams && (
            <Button
              aria-label="Run input"
              title="Run with an operator directive"
              disabled={playback.phase !== "idle" || ctrl.status.kind === "saving"}
              onClick={() => setRunInputOpen(true)}
            >
              <PromptIcon />
            </Button>
          )}
        </>
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
    </>
  );

  return (
    <ToastHost>
      <SaveErrorToast status={ctrl.status} />
      <PlaybackErrorToast error={playback.error} />
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
                edges={canvasEdges}
                nodeTypes={CANVAS_NODE_TYPES}
                edgeTypes={CANVAS_EDGE_TYPES}
                nodesDraggable={!playing}
                nodesConnectable={!playing}
                // Nodes stay selectable while a run plays: ReactFlow gates a
                // node's pointer-events on selectable|draggable|onClick|mouse*,
                // so a non-selectable node with no click handler is inert - the
                // double-click and the open affordance never reach it. Editing
                // stays locked by the draggable/connectable/onConnect/delete/
                // onPaneClick gates below, not by making the node inert.
                elementsSelectable
                onNodesChange={ctrl.onNodesChange}
                onEdgesChange={ctrl.onEdgesChange}
                onConnect={playing ? undefined : ctrl.onConnect}
                onMoveEnd={ctrl.onMoveEnd}
                onNodeClick={playing ? undefined : onNodeClick}
                // Double-click opens the node inspector in BOTH modes; while a
                // run plays it opens read-only (the inspector is fully
                // disabled). Zoom-on-double-click is held during a run so the
                // inspect gesture is not swallowed by a canvas zoom.
                onNodeDoubleClick={onNodeDoubleClick}
                zoomOnDoubleClick={!playing}
                onEdgeClick={playing ? undefined : onEdgeClick}
                onEdgeMouseEnter={onEdgeMouseEnter}
                onEdgeMouseLeave={onEdgeMouseLeave}
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
            <RunLogPanel events={runLog} />
          </div>
        </div>
      </div>

      {runInputOpen && (
        <Modal
          title={hasParams ? "Run workflow" : "Run input"}
          ariaLabel={hasParams ? "Run the workflow with parameters" : "Run with an operator directive"}
          onClose={() => {
            setRunInputOpen(false);
            setParamError(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setRunInputOpen(false);
                  setParamError(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={handleRunWithInput}>
                <PlayIcon />
                Run
              </Button>
            </>
          }
        >
          {hasParams && (
            <RunParamFields
              params={declaredParams}
              values={runParamValues}
              onChange={(name, value) =>
                setRunParamValues((prev) => ({ ...prev, [name]: value }))
              }
            />
          )}
          {paramError !== null && (
            <p className="hw-error" role="alert">
              {paramError}
            </p>
          )}
          <Field label="Operator input" htmlFor="hw-run-input">
            <Textarea
              id="hw-run-input"
              aria-label="Operator input"
              rows={6}
              value={runInput}
              placeholder="A run-wide directive layered above every agent task at highest priority."
              onChange={(e) => setRunInput(e.target.value)}
            />
          </Field>
          <p className="hw-note">
            Optional. Steers this run only - it overrides conflicting node
            instructions and otherwise binds as an additional constraint. Leave
            empty to run the graph as authored.
          </p>
        </Modal>
      )}

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
            <>
              {!playing && (
                <Button
                  variant="danger"
                  onClick={() => {
                    ctrl.removeEdge(ctrl.selectedEdge!.id);
                    closeEdgeEditor();
                  }}
                >
                  Delete edge
                </Button>
              )}
              <Button variant="primary" onClick={closeEdgeEditor}>
                {playing ? "Close" : "Done"}
              </Button>
            </>
          }
        >
          <EdgeInspector
            edge={ctrl.selectedEdge}
            sourceType={
              ctrl.nodes.find((n) => n.id === ctrl.selectedEdge!.source)?.data.node.type ??
              "agent_task"
            }
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
    </ToastHost>
  );
}
