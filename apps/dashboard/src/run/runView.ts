// Pure helpers for the run inspector: terminal-state classification, node-status
// colours, and overlaying a run's per-node statuses onto the flow graph. Kept
// React-free so the mapping and polling-stop logic are unit-testable.
import { workflowToFlow, type FlowEdge } from "../editor/graphMapping";
import type {
  NodeRunState,
  NodeStatus,
  RunState,
  RunStatus,
  SpecDetail,
  WorkflowNode,
} from "../api/types";
import type { Node as FlowNodeBase } from "@xyflow/react";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Whether editor playback should hand the run over to the run inspector.
 *  True on every terminal status, and on `waiting`: a human_review node parks
 *  the run indefinitely and only the inspector has review controls, so staying
 *  on the editor canvas would stall the operator on a run that cannot finish
 *  there. */
export function shouldHandOff(status: RunStatus): boolean {
  return isTerminalRun(status) || status === "waiting";
}

const ACTIVE_NODE_STATUSES = new Set<NodeStatus>(["scheduled", "running"]);

/** Whether the node's worker is blocked on a command approval right now.
 *  Pending only counts on an active node: a baked pending record on a settled
 *  node means the worker died mid-prompt, which is not "waiting". */
export function isApprovalPending(state: NodeRunState | undefined): boolean {
  return (
    state !== undefined &&
    ACTIVE_NODE_STATUSES.has(state.status) &&
    state.telemetry?.approval?.state === "pending"
  );
}

// Kept in sync with the `--hw-status-*` variables in ui/theme.css — running is
// always blue and completed always green (operator-confirmed semantics).
const STATUS_COLORS: Record<NodeStatus, string> = {
  pending: "#6b7280",
  scheduled: "#7aa7d6",
  running: "#3b82f6",
  waiting_for_review: "#d6b25e",
  completed: "#2ea44f",
  failed: "#c0392b",
  skipped: "#4b5563",
  cancelled: "#374151",
};

export function statusColor(status: NodeStatus): string {
  return STATUS_COLORS[status];
}

export interface RunNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status?: NodeStatus;
  /** See {@link isApprovalPending}; drives the node card's waiting badge. */
  approvalPending?: boolean;
  /** Open this node's detail modal. Carried on node data (not via React
   *  context) because ReactFlow does not propagate context into custom node
   *  components. The inspector sets it; the editor-playback canvas leaves it
   *  unset so a running node renders without the open button. */
  onSelect?: (id: string) => void;
}

export type RunFlowNode = FlowNodeBase<RunNodeData>;

export interface RunGraph {
  nodes: RunFlowNode[];
  edges: FlowEdge[];
}

/** Canvas type key rendered by RunNodeView. Distinct from WORKFLOW_NODE_TYPE so
 *  one stable nodeTypes registry can hold both renderers and a canvas switches
 *  by remapping node `type` — never by swapping the registry object, which
 *  ReactFlow warns about. */
export const RUN_NODE_TYPE = "workflow-run";

function runNodeData(node: WorkflowNode, state: NodeRunState | undefined): RunNodeData {
  const data: RunNodeData = { node };
  if (state?.status !== undefined) data.status = state.status;
  if (isApprovalPending(state)) data.approvalPending = true;
  return data;
}

/** Tag already-mapped flow nodes (an editor canvas mid-playback) with their run
 *  status, preserving live positions; nodes the run has not reached stay
 *  status-less. */
export function overlayRunStatus(
  nodes: readonly FlowNodeBase<{ node: WorkflowNode } & Record<string, unknown>>[],
  run: RunState,
): RunFlowNode[] {
  return nodes.map((node) => ({
    ...node,
    type: RUN_NODE_TYPE,
    data: runNodeData(node.data.node, run.nodes[node.id]),
  }));
}

/** Build a read-only flow graph for a run: the workflow's nodes/edges/layout
 *  with each node tagged by its current run status (undefined if not reached). */
export function applyRunStatus(detail: SpecDetail, run: RunState): RunGraph {
  const flow = workflowToFlow(detail.workflow, detail.ui);
  return { nodes: overlayRunStatus(flow.nodes, run), edges: flow.edges };
}
