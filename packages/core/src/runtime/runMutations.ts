/**
 * Pure run-state mutations the dashboard exposes: cancel a run, and retry it
 * (the whole graph, or one failed node). Like the transition helpers, these
 * return a new state and never mutate the input.
 */

import type { RunState, NodeRunState } from "../schema/run.ts";
import { TERMINAL_NODE_STATUSES, TERMINAL_RUN_STATUSES } from "./status.ts";

export class RetryError extends Error {
  override name = "RetryError";
}

/**
 * Cancel a run: mark it cancelled and cancel every still-active node. A run that
 * is already terminal is returned unchanged (cancel is idempotent / safe).
 */
export function cancelRun(run: RunState): RunState {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
  const nodes: Record<string, NodeRunState> = {};
  for (const [id, node] of Object.entries(run.nodes)) {
    nodes[id] = TERMINAL_NODE_STATUSES.has(node.status) ? node : { ...node, status: "cancelled" };
  }
  return { ...run, status: "cancelled", nodes };
}

/** A node reset back to a clean pending state, dropping its prior run result. */
function resetNode(node: NodeRunState): NodeRunState {
  return {
    node_id: node.node_id,
    ...(node.node_type !== undefined ? { node_type: node.node_type } : {}),
    status: "pending",
  };
}

/**
 * Retry a run. With no `node`, the whole graph resets to pending and the run to
 * `created` (the next tick re-advances from the entry node). With a `node`, only
 * that node — which must currently be `failed` — resets, and the run resumes
 * `running`. Clearing the node's `hermes_task_id` forces a fresh backing handle.
 */
export function retryRun(run: RunState, opts: { node?: string } = {}): RunState {
  if (opts.node !== undefined) {
    const node = run.nodes[opts.node];
    if (!node) throw new RetryError(`unknown node '${opts.node}'`);
    if (node.status !== "failed") {
      throw new RetryError(`node '${opts.node}' is not failed (status ${node.status})`);
    }
    return {
      ...run,
      status: "running",
      nodes: { ...run.nodes, [opts.node]: resetNode(node) },
    };
  }
  const nodes: Record<string, NodeRunState> = {};
  for (const [id, node] of Object.entries(run.nodes)) nodes[id] = resetNode(node);
  return { ...run, status: "created", nodes };
}
