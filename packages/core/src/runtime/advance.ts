/**
 * The advance engine: given a workflow and the current run state (with node
 * outcomes and review decisions already recorded by the bridge), decide what
 * happens next — which agent_task nodes to schedule, which human_review nodes
 * are waiting, and the resulting run status.
 *
 * Pure and idempotent: calling it twice with the same input yields the same
 * decision (already-active nodes are never re-scheduled). Routing-only nodes
 * (`condition`) and `finish` are resolved instantly within a single call.
 *
 * Loops: a node is re-run when a routing node with a higher completion `seq`
 * points at an already-terminal node (a back-edge re-entry). This re-runs the
 * fix → validate style loops without re-running nodes that already advanced.
 */

import type { Workflow, Edge } from "../schema/workflow.ts";
import type { RunState, RunStatus, NodeStatus, NodeOutcome, NodeRunState } from "../schema/run.ts";
import { nodeMap, outgoingEdges, entryNodes } from "../schema/graph.ts";
import { evaluateCondition } from "./conditions.ts";
import { TERMINAL_NODE_STATUSES } from "./status.ts";

export interface AdvanceResult {
  run_status: RunStatus;
  /** Set when the run reached a finish node. */
  finish_outcome?: NodeOutcome;
  /** Work node ids (agent_task, script) to schedule on their executor now. */
  schedule: string[];
  /** human_review node ids now awaiting a decision. */
  waiting: string[];
  /** Node status changes to persist (includes resolved condition/finish nodes). */
  node_updates: Record<string, NodeStatus>;
  /**
   * Whether the just-scheduled set can run inline (synchronously, no tick
   * round-trip): non-empty and every scheduled node is a `script` (the script
   * executor settles in-process). `agent_task` work, or a mixed set, makes the
   * tick ineligible — those run durably. `condition` / `finish` resolve within
   * this call and never appear in `schedule`, so they never gate eligibility.
   */
  inline_eligible: boolean;
}

/** Edges to follow out of a routing node, honouring conditions and fallbacks. */
export function selectOutgoing(workflow: Workflow, run: RunState, nodeId: string): Edge[] {
  const edges = outgoingEdges(workflow, nodeId);
  const plain = edges.filter((e) => !e.condition && !e.fallback);
  const conditioned = edges.filter((e) => e.condition !== undefined);
  if (conditioned.length === 0) return plain;
  const passed = conditioned.filter((e) => evaluateCondition(e.condition as never, run, nodeId));
  if (passed.length > 0) return [...passed, ...plain];
  return [...edges.filter((e) => e.fallback), ...plain];
}

/** A node "routes" when it has produced an outcome or a review decision. */
function routes(state: NodeRunState | undefined, type: string): boolean {
  if (!state) return false;
  if (type === "human_review") return state.review_decision !== undefined;
  return state.status === "completed" && state.outcome !== undefined;
}

export function advance(workflow: Workflow, run: RunState): AdvanceResult {
  const nodes = nodeMap(workflow);
  const updates: Record<string, NodeStatus> = {};
  const schedule: string[] = [];
  const waiting: string[] = [];
  let finishOutcome: NodeOutcome | undefined;
  let failedDeadEnd = false;
  let aborted = false;

  const merged = (id: string): NodeStatus => updates[id] ?? run.nodes[id]?.status ?? "pending";
  const setStatus = (id: string, status: NodeStatus): void => {
    if (merged(id) !== status) updates[id] = status;
  };
  const seqOf = (id: string): number => run.nodes[id]?.seq ?? 0;

  const routerIds = workflow.nodes.filter((n) => routes(run.nodes[n.id], n.type)).map((n) => n.id);

  // Pass 1: detect loop re-entries. A target that is already terminal is reset
  // to pending when a router with a strictly higher completion seq points at it.
  const resets = new Set<string>();
  for (const rid of routerIds) {
    for (const edge of selectOutgoing(workflow, run, rid)) {
      const target = run.nodes[edge.to];
      if (target && TERMINAL_NODE_STATUSES.has(target.status) && seqOf(rid) > seqOf(edge.to)) {
        resets.add(edge.to);
      }
    }
  }
  for (const id of resets) setStatus(id, "pending");

  const routeQueue: string[] = [];
  const activate = (id: string): void => {
    if (merged(id) !== "pending") return; // already active or settled — idempotent
    const node = nodes.get(id);
    if (!node) return;
    switch (node.type) {
      case "agent_task":
      case "script":
        // Both are "work" nodes: schedule them and let the executor settle an
        // outcome. The composite executor routes a script node to the local
        // ScriptExecutor by its compiled `kind`.
        setStatus(id, "scheduled");
        schedule.push(id);
        break;
      case "human_review":
        setStatus(id, "waiting_for_review");
        waiting.push(id);
        break;
      case "wait":
        // Worker-free external wait: no executor, no card. The node parks active
        // (`running`) and the Python tick polls its `wait_for` predicate each
        // tick, settling it `completed` with an outcome — at which point it
        // routes like any work node. Not added to `schedule` (nothing to run).
        setStatus(id, "running");
        break;
      case "condition":
      case "prompt":
        // Routing-only: both resolve instantly and follow their outgoing edge.
        // A prompt node does no work; its authored text was layered into the
        // downstream agent_task prompt at compile time.
        setStatus(id, "completed");
        routeQueue.push(id);
        break;
      case "finish":
        setStatus(id, "completed");
        finishOutcome = node.outcome ?? "success";
        break;
    }
  };

  // Seed: the entry node is activated once, at run start (it has no incoming edge).
  const entry = entryNodes(workflow)[0];
  if (entry) activate(entry.id);

  // Routers (except those reset this tick) propagate to their selected targets.
  for (const rid of routerIds) {
    if (!resets.has(rid)) routeQueue.push(rid);
  }

  const processed = new Set<string>();
  while (routeQueue.length > 0) {
    const rid = routeQueue.shift() as string;
    if (processed.has(rid)) continue;
    processed.add(rid);
    const node = nodes.get(rid);
    if (!node) continue;
    if (node.type === "human_review" && run.nodes[rid]?.review_decision !== undefined) {
      setStatus(rid, "completed");
    }
    // A node flagged to abort the run (e.g. an adopt that drove zero cards) fails
    // the run closed: do NOT follow its outgoing edges, so the run cannot fall
    // through to a downstream build/PR after the real work was skipped.
    if (run.nodes[rid]?.abort_run) {
      aborted = true;
      continue;
    }
    const targets = selectOutgoing(workflow, run, rid);
    if (targets.length === 0) {
      if (node.type !== "finish") failedDeadEnd = true; // run is stuck, cannot proceed
      continue;
    }
    for (const edge of targets) activate(edge.to);
  }

  const inlineEligible =
    schedule.length > 0 && schedule.every((id) => nodes.get(id)?.type === "script");

  return {
    run_status: resolveRunStatus(workflow, run, merged, finishOutcome, failedDeadEnd, aborted),
    ...(finishOutcome !== undefined ? { finish_outcome: finishOutcome } : {}),
    schedule,
    waiting,
    node_updates: updates,
    inline_eligible: inlineEligible,
  };
}

function resolveRunStatus(
  workflow: Workflow,
  run: RunState,
  merged: (id: string) => NodeStatus,
  finishOutcome: NodeOutcome | undefined,
  failedDeadEnd: boolean,
  aborted: boolean,
): RunStatus {
  // A hard abort (e.g. an adopt that drove zero cards) closes the run failed
  // regardless of any node still active or waiting in a parallel branch.
  if (aborted) return "failed";
  if (finishOutcome !== undefined) return finishOutcome === "failure" ? "failed" : "completed";

  let hasActive = false;
  let hasWaiting = false;
  for (const node of workflow.nodes) {
    const status = merged(node.id);
    if (status === "scheduled" || status === "running") hasActive = true;
    if (status === "waiting_for_review" && run.nodes[node.id]?.review_decision === undefined) {
      hasWaiting = true;
    }
  }
  if (hasActive) return "running";
  if (hasWaiting) return "waiting";
  if (failedDeadEnd) return "failed";
  return run.status === "created" ? "running" : run.status;
}
