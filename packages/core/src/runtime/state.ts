/**
 * Run-state construction and legal status transitions. Transition helpers are
 * pure: they return a new state and never mutate the input. The Python bridge
 * uses these when applying advance decisions to `runs.db`.
 */

import type { RunState, RunStatus, NodeStatus, NodeRunState } from "../schema/run.ts";
import type { Workflow } from "../schema/workflow.ts";
import type { ParamValue } from "../templates/params.ts";

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ["running", "cancelled"],
  running: ["waiting", "completed", "failed", "cancelled"],
  waiting: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const NODE_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  pending: ["scheduled", "skipped", "cancelled"],
  scheduled: ["running", "waiting_for_review", "completed", "failed", "cancelled"],
  running: ["waiting_for_review", "completed", "failed", "cancelled"],
  waiting_for_review: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return from === to || NODE_TRANSITIONS[from].includes(to);
}

/** Initialise a fresh run with every node pending and run status `created`. */
export function createRunState(
  workflow: Workflow,
  runId: string,
  projectId?: string,
  origin?: string,
  input?: string,
  params?: Record<string, ParamValue>,
  workflowPath?: string,
): RunState {
  const nodes: Record<string, NodeRunState> = {};
  for (const node of workflow.nodes) {
    nodes[node.id] = { node_id: node.id, node_type: node.type, status: "pending" };
  }
  const run: RunState = {
    run_id: runId,
    workflow_id: workflow.id,
    workflow_version: workflow.version,
    status: "created",
    nodes,
  };
  if (workflowPath !== undefined && workflowPath !== "") run.workflow_path = workflowPath;
  if (projectId !== undefined) run.project_id = projectId;
  if (origin !== undefined && origin !== "") run.origin = origin;
  if (input !== undefined && input !== "") run.input = input;
  if (params !== undefined && Object.keys(params).length > 0) run.params = params;
  return run;
}

export function transitionRun(run: RunState, to: RunStatus): RunState {
  if (!canTransitionRun(run.status, to)) {
    throw new IllegalTransitionError(`run cannot move from ${run.status} to ${to}`);
  }
  return { ...run, status: to };
}

export function transitionNode(run: RunState, nodeId: string, to: NodeStatus): RunState {
  const node = run.nodes[nodeId];
  if (!node) throw new IllegalTransitionError(`unknown node '${nodeId}'`);
  if (!canTransitionNode(node.status, to)) {
    throw new IllegalTransitionError(`node '${nodeId}' cannot move from ${node.status} to ${to}`);
  }
  return { ...run, nodes: { ...run.nodes, [nodeId]: { ...node, status: to } } };
}
