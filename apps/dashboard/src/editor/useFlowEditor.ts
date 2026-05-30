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
import { flowToWorkflow, workflowToFlow, type FlowEdge, type FlowNode } from "./graphMapping";
import type { WorkflowsApi } from "../api/client";
import type { SpecDetail } from "../api/types";

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
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onMoveEnd: (event: unknown, viewport: Viewport) => void;
  save: () => Promise<SpecDetail | null>;
}

export function useFlowEditor(detail: SpecDetail, client: WorkflowsApi): FlowEditorController {
  const initial = useMemo(() => workflowToFlow(detail.workflow, detail.ui), [detail]);
  const [nodes, , onNodesChangeRaw] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<FlowEdge>(initial.edges);
  const [viewport, setViewport] = useState<Viewport | undefined>(initial.viewport);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

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

  const onMoveEnd = useCallback((_event: unknown, next: Viewport) => {
    setViewport(next);
    setDirty(true);
  }, []);

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

  return { nodes, edges, viewport, dirty, status, onNodesChange, onEdgesChange, onConnect, onMoveEnd, save };
}
