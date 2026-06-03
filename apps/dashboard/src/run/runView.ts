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

const STATUS_COLORS: Record<NodeStatus, string> = {
  pending: "#6b7280",
  scheduled: "#7aa7d6",
  running: "#3b82f6",
  waiting_for_review: "#d6b25e",
  completed: "#4a8f4a",
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
}

export type RunFlowNode = FlowNodeBase<RunNodeData>;

export interface RunGraph {
  nodes: RunFlowNode[];
  edges: FlowEdge[];
}

/** Build a read-only flow graph for a run: the workflow's nodes/edges/layout
 *  with each node tagged by its current run status (undefined if not reached). */
export function applyRunStatus(detail: SpecDetail, run: RunState): RunGraph {
  const flow = workflowToFlow(detail.workflow, detail.ui);
  const nodes: RunFlowNode[] = flow.nodes.map((node) => {
    const state = run.nodes[node.id];
    const data: RunNodeData = { node: node.data.node };
    if (state?.status !== undefined) data.status = state.status;
    if (isApprovalPending(state)) data.approvalPending = true;
    return { ...node, data };
  });
  return { nodes, edges: flow.edges };
}
