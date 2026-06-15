/**
 * Run-state types. The run state is the in-memory projection of a workflow run;
 * the Python bridge persists it to `runs.db` and reconstructs it on each tick.
 */

import type { ReviewOption } from "./nodes.ts";

export type RunStatus = "created" | "running" | "waiting" | "completed" | "failed" | "cancelled";

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

/**
 * State of a dangerous-command approval observed inside the node's worker.
 * `pending` means the worker is blocked on a human answer right now; the UI
 * renders that only while the node is still active. A resolved `deny` or
 * `timeout` choice persists so a subsequent node failure has context.
 */
export interface NodeTelemetryApproval {
  state: "pending" | "resolved";
  command?: string;
  description?: string;
  /** Where the prompt was shown: "cli" | "gateway" (opaque host value). */
  surface?: string;
  /** Opaque host session key, kept as debugging context only. */
  session_key?: string;
  /** once | session | always | deny | timeout (host values, opaque). */
  choice?: string;
  requested_at?: number;
  resolved_at?: number;
}

/**
 * Per-node agent telemetry aggregated from the host's observer hooks
 * (hermes.observer.v1 and earlier) by the worker-side recorder. Additive and
 * entirely optional: nodes executed without a kanban worker (DirectExecutor,
 * script nodes) simply have no telemetry. All counters cover the most recent
 * worker attempt.
 */
export interface NodeTelemetry {
  /** Observed agent-activity window in ms (first to last observer event). */
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Provider API attempts (successes and failures). */
  api_calls?: number;
  tool_calls?: number;
  /** Tool calls that reported an error status (v1 hosts only). */
  tool_errors?: number;
  /** Delegated child agents that finished. */
  subagents?: number;
  /** Most recent structured error (provider or tool), when one occurred. */
  error_type?: string;
  error_message?: string;
  approval?: NodeTelemetryApproval;
}

export interface NodeRunState {
  node_id: string;
  status: NodeStatus;
  /** Kanban task backing this node, when one was created. */
  hermes_task_id?: string;
  /**
   * For an `adopt` node, the existing board card(s) it drives. The node settles
   * only when ALL of these reach a terminal state. `hermes_task_id` mirrors the
   * first id (for telemetry / subscription); the gating reads this list.
   */
  driven_task_ids?: string[];
  /**
   * Driven cards already routed through the native review stage (adopt nodes with
   * a `review_profile`), so the done->review transition fires exactly once per
   * card and the node settles on the post-review terminal state.
   */
  reviewed_task_ids?: string[];
  /**
   * Bookkeeping for a sequential `adopt` node (`sequential: true`): the cards not
   * yet promoted (`pending`), the assignee to promote them under, and the
   * accumulated `outputs` / `failed` flag from already-terminal cards. The poll
   * loop promotes one card at a time and aggregates the final outcome from this.
   */
  adopt_seq?: {
    pending: string[];
    assignee: string;
    outputs: string[];
    failed: boolean;
  };
  /** Set once the node reaches a terminal state. */
  outcome?: NodeOutcome;
  /** Decision recorded for a human_review node. */
  review_decision?: ReviewOption;
  /**
   * Optional free-text payload the operator attached when resolving a
   * human_review gate (e.g. which option they picked, or instructions). Lands in
   * run state and is consumable downstream as `{{nodes.<gate>.review_note}}`,
   * a channel distinct from a work node's `.output`.
   */
  review_note?: string;
  /** Captured node output (e.g. the worker's completion summary). */
  output?: string;
  /** Epoch seconds a `wait` node first began polling, for its optional timeout. */
  wait_started_at?: number;
  error?: string;
  /**
   * Monotonic completion order within the run, assigned by the bridge each time
   * a node settles or a review decision is recorded. Used by the advance engine
   * to re-run a node when a loop edge re-enters it (a router with a higher seq
   * pointing at an already-terminal node).
   */
  seq?: number;
  /** Observer-derived agent telemetry, merged by the bridge at settle time. */
  telemetry?: NodeTelemetry;
}

export interface RunState {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  project_id?: string;
  /**
   * Free-form operator input supplied at run start (CLI `--input`, the
   * `/workflow run` command, or the dashboard Play button). The engine layers it
   * above EVERY agent_task node's prompt as the highest-priority block, so it
   * overrides conflicting node instructions and otherwise binds as an additional
   * constraint. Persisted so it applies to every node across ticks. Absent for a
   * run started without operator input.
   */
  input?: string;
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
