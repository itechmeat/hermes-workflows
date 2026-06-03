// Editing state for the flow canvas, split from the visual component so its
// logic (dirty tracking, connect, save round-trip) is unit-testable without a
// mounted ReactFlow. The component binds these to <ReactFlow>.
import { useCallback, useMemo, useState } from "react";
import {
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import {
  flowToWorkflow,
  workflowToFlow,
  WORKFLOW_NODE_TYPE,
  type FlowEdge,
  type FlowNode,
} from "./graphMapping";
import { layout } from "./layout";
import type { WorkflowsApi } from "../api/client";
import type { NodeType, SpecDetail, WorkflowNode } from "../api/types";

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

// Change kinds that represent a real edit; `dimensions`/`select` are emitted by
// measurement and selection and must not mark the graph dirty (else it is dirty
// the moment it mounts).
const STRUCTURAL_NODE_CHANGES = new Set(["position", "remove", "add", "replace"]);
const STRUCTURAL_EDGE_CHANGES = new Set(["remove", "add", "replace"]);

export interface FlowEditorController {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: Viewport | undefined;
  dirty: boolean;
  status: SaveStatus;
  selectedNode: FlowNode | null;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onMoveEnd: (event: unknown, viewport: Viewport) => void;
  selectNode: (id: string | null) => void;
  updateNode: (id: string, patch: Partial<WorkflowNode>) => void;
  addNode: (type: NodeType) => string;
  duplicateNode: (id: string) => string | null;
  applyLayout: () => void;
  save: () => Promise<SpecDetail | null>;
}

// Node ids are sequential numbers (kept as strings, the schema's id type): a
// stable handle that does not bake the node type into the name, so the canvas
// can show the human type label separately from a short id.
function freshId(nodes: readonly FlowNode[]): string {
  const taken = new Set(nodes.map((node) => node.id));
  let n = 1;
  while (taken.has(String(n))) n += 1;
  return String(n);
}

function blankNode(type: NodeType, id: string): WorkflowNode {
  if (type === "agent_task") return { id, type, prompt: "", max_retries: 3 };
  if (type === "script") return { id, type, command: "" };
  return { id, type };
}

export function useFlowEditor(detail: SpecDetail, client: WorkflowsApi): FlowEditorController {
  const initial = useMemo(() => workflowToFlow(detail.workflow, detail.ui), [detail]);
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<FlowEdge>(initial.edges);
  const [viewport, setViewport] = useState<Viewport | undefined>(initial.viewport);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChangeRaw(changes as NodeChange<FlowNode>[]);
      if (changes.some((change) => STRUCTURAL_NODE_CHANGES.has(change.type))) setDirty(true);
    },
    [onNodesChangeRaw],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeRaw(changes as EdgeChange<FlowEdge>[]);
      if (changes.some((change) => STRUCTURAL_EDGE_CHANGES.has(change.type))) setDirty(true);
    },
    [onEdgesChangeRaw],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => addEdge(connection, current));
      setDirty(true);
    },
    [setEdges],
  );

  const onMoveEnd = useCallback((event: unknown, next: Viewport) => {
    // Always track the viewport so a save persists the current view, but only
    // mark dirty on a user gesture: xyflow's programmatic fitView on mount fires
    // onMoveEnd with a null event, which must not dirty an untouched graph.
    setViewport(next);
    if (event !== null && event !== undefined) setDirty(true);
  }, []);

  const selectNode = useCallback((id: string | null) => setSelectedNodeId(id), []);

  const updateNode = useCallback(
    (id: string, patch: Partial<WorkflowNode>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? { ...node, data: { node: { ...node.data.node, ...patch } as WorkflowNode } }
            : node,
        ),
      );
      setDirty(true);
    },
    [setNodes],
  );

  const addNode = useCallback(
    (type: NodeType): string => {
      // Derive the id/placement from the current nodes outside the state updater
      // so the updater stays pure (React may invoke it more than once).
      const id = freshId(nodes);
      const placed: FlowNode = {
        id,
        type: WORKFLOW_NODE_TYPE,
        position: { x: 80 + nodes.length * 40, y: 80 + nodes.length * 20 },
        data: { node: blankNode(type, id) },
      };
      setNodes((current) => [...current, placed]);
      setSelectedNodeId(id);
      setDirty(true);
      return id;
    },
    [nodes, setNodes],
  );

  const duplicateNode = useCallback(
    (id: string): string | null => {
      const source = nodes.find((node) => node.id === id);
      if (source === undefined) return null;
      const newId = freshId(nodes);
      const clone: FlowNode = {
        id: newId,
        type: WORKFLOW_NODE_TYPE,
        position: { x: source.position.x + 40, y: source.position.y + 40 },
        // Copy every field; only the id is rewritten so edges stay unambiguous.
        data: { node: { ...source.data.node, id: newId } as WorkflowNode },
      };
      setNodes((current) => [...current, clone]);
      setSelectedNodeId(newId);
      setDirty(true);
      return newId;
    },
    [nodes, setNodes],
  );

  const applyLayout = useCallback(() => {
    // Compute outside the updater so it stays pure (React may re-run updaters).
    const placed = layout(nodes, edges);
    setNodes((current) =>
      current.map((node) => {
        const point = placed[node.id];
        return point === undefined ? node : { ...node, position: point };
      }),
    );
    setDirty(true);
  }, [nodes, edges, setNodes]);

  const save = useCallback(async (): Promise<SpecDetail | null> => {
    setStatus({ kind: "saving" });
    const { workflow, ui } = flowToWorkflow(detail.workflow, nodes, edges, viewport);
    try {
      const saved = await client.saveWorkflow(detail.workflow.id, { workflow, ui });
      setDirty(false);
      setStatus({ kind: "saved" });
      return saved;
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "save failed" });
      return null;
    }
  }, [client, detail.workflow, nodes, edges, viewport]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  return {
    nodes,
    edges,
    viewport,
    dirty,
    status,
    selectedNode,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onMoveEnd,
    selectNode,
    updateNode,
    addNode,
    duplicateNode,
    applyLayout,
    save,
  };
}
