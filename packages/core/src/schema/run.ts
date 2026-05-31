/**
 * Run-state types. The run state is the in-memory projection of a workflow run;
 * the Python bridge persists it to `runs.db` and reconstructs it on each tick.
 */

import type { ReviewOption } from "./nodes.ts";

export type RunStatus =
  | "created"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "waiting_for_review"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

/** Outcome of a node, mapped from the native Kanban task result by the bridge. */
export type NodeOutcome = "success" | "failure";

export interface NodeRunState {
  node_id: string;
  status: NodeStatus;
  /** Kanban task backing this node, when one was created. */
  hermes_task_id?: string;
  /** Set once the node reaches a terminal state. */
  outcome?: NodeOutcome;
  /** Decision recorded for a human_review node. */
  review_decision?: ReviewOption;
  /** Captured node output (e.g. the worker's completion summary). */
  output?: string;
  error?: string;
  /**
   * Monotonic completion order within the run, assigned by the bridge each time
   * a node settles or a review decision is recorded. Used by the advance engine
   * to re-run a node when a loop edge re-enters it (a router with a higher seq
   * pointing at an already-terminal node).
   */
  seq?: number;
}

export interface RunState {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  project_id?: string;
  /**
   * The chat the run originated from, an opaque `<platform>:<chat>[:<thread>]`
   * string Hermes' native delivery interprets. Captured for model-started runs
   * (a `pre_gateway_dispatch` hook) and cron-started runs (the schedule);
   * absent for dashboard / CLI / headless runs, which fall back to a configured
   * default delivery target.
   */
  origin?: string;
  /**
   * Opaque markers for lifecycle effects already emitted for this run
   * (notification notices keyed by event name, memory writes keyed `mem:…`), so
   * a run that stays terminal across ticks is never re-announced or re-written.
   * The engine is the only writer; absent means nothing emitted yet.
   */
  notified?: string[];
  nodes: Record<string, NodeRunState>;
}
