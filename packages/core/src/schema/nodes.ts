/**
 * Node type definitions for a workflow graph.
 *
 * Field names mirror the on-disk YAML/JSON spec 1:1 (snake_case where the spec
 * uses it) so loading is parse + validate with no field remapping layer.
 */

export type NodeType =
  | "agent_task"
  | "script"
  | "condition"
  | "human_review"
  | "finish"
  | "wait"
  | "prompt";

export type ReviewOption = "approved" | "rejected" | "needs_changes";

export type WorkspaceKind = "scratch" | "worktree";

export interface AgentTaskNode {
  id: string;
  type: "agent_task";
  title?: string;
  description?: string;
  /** Profile to assign the Kanban task to. Falls back to `defaults.profile`. */
  profile?: string;
  /** Per-node model override (maps to the native `model_override` column). */
  model?: string;
  /** Extra skills loaded for the worker (maps to the native `skills` column). */
  skills?: string[];
  workdir?: string;
  workspace?: { type: WorkspaceKind };
  /** The core "text prompt" handed to the worker. */
  prompt: string;
  /** Templated references to prior node outputs, e.g. `{{nodes.summarize.output}}`. */
  input_mapping?: Record<string, string>;
  /** Maps to the native `max_retries` column. */
  max_retries?: number;
  /** Maps to the native `max_runtime_seconds` column. */
  timeout_seconds?: number;
  /**
   * Drive an EXISTING Kanban card (or cards) instead of creating a new one: the
   * executor assigns the node's `profile`, promotes the card into the dispatch
   * lane, then polls it to terminal. Requires `task_ref`. The work is the card,
   * the native way, rather than a parallel workflow-owned card.
   */
  adopt?: boolean;
  /**
   * Which card(s) an `adopt` node drives: a literal task id, or a
   * `{{nodes.<id>.output.task_ids}}` reference resolved at schedule time to the
   * task ids an upstream node surfaced. Only meaningful with `adopt`.
   */
  task_ref?: string;
  /**
   * Reviewer profile for a native post-implementation review stage on a driven
   * card: once the card reaches `done`, it is routed through Hermes' own `review`
   * status (assigned to this profile, claimed via `claim_review_task`) and the
   * node settles only when the review reaches terminal. Optional; only meaningful
   * with `adopt`. Absent leaves the driven card settling on first `done`.
   */
  review_profile?: string;
  /**
   * For a multi-card `adopt` node: drive the referenced cards ONE AT A TIME
   * instead of promoting them all into the dispatch lane at once. Promote card
   * N, wait until it is terminal (incl. its review stage), then promote N+1, so
   * each worker builds on the prior cards' committed work on a shared branch.
   * The node still settles when all are terminal (failure if any failed).
   * Default (absent/false) keeps the concurrent behavior. Only meaningful with
   * `adopt`; a no-op for a single-card adopt.
   */
  sequential?: boolean;
  /**
   * Per-node control over the native per-card completion notification: when this
   * node's Kanban card settles, whether the run origin is subscribed to its
   * terminal event (the "done" ping). Unset inherits the workflow-level default
   * (`notifications.subscribe_cards`, itself defaulting true); `true`/`false`
   * override it for this node only. Lets an operator have some nodes ping and
   * others stay quiet without changing the workflow default.
   */
  notify_completion?: boolean;
}

/**
 * A deterministic shell command run with no LLM (lint, tests, a build step).
 * It settles to `success`/`failure` by exit code, so it plugs into the same
 * `node_status` branching as any work node. It runs locally in the plugin in
 * any scope — Hermes has no no-agent Kanban task mode.
 */
export interface ScriptNode {
  id: string;
  type: "script";
  title?: string;
  description?: string;
  /** The shell command to run. Required. */
  command: string;
  /** Working directory the command runs in. */
  workdir?: string;
  /** Hard timeout; on expiry the node settles `failure`. */
  timeout_seconds?: number;
  /** Allowlist of environment variable names exposed to the command (not the
   *  full process env). Absent means no inherited env beyond the executor's. */
  env?: string[];
}

/** A routing-only node. It performs no work; its outgoing edges carry conditions. */
export interface ConditionNode {
  id: string;
  type: "condition";
  title?: string;
  description?: string;
}

export interface HumanReviewNode {
  id: string;
  type: "human_review";
  title?: string;
  description?: string;
  /** Allowed review decisions. Defaults to all three review options. */
  options?: ReviewOption[];
}

export interface FinishNode {
  id: string;
  type: "finish";
  title?: string;
  description?: string;
  outcome?: "success" | "failure";
}

/**
 * What a `wait` node polls for, worker-free, inside the engine tick. One known
 * condition today: `github_pr_merged`. Additive — a new condition is a new key.
 */
export interface WaitCondition {
  /**
   * Wait until the referenced GitHub PR is merged. The value is the PR (a URL or
   * number) or a `{{nodes.<id>.output}}` reference resolved at poll time. The
   * node settles `success` on MERGED, `failure` on CLOSED-not-merged, and keeps
   * waiting while OPEN.
   */
  github_pr_merged: string;
}

/**
 * A worker-free wait for an external signal: the engine evaluates `wait_for` in
 * its periodic tick (no Kanban card, no LLM worker) and settles the node when
 * the condition resolves, branching on `node_status` like any work node.
 */
export interface WaitNode {
  id: string;
  type: "wait";
  title?: string;
  description?: string;
  wait_for: WaitCondition;
  /** Optional cap: settle `failure` if the condition is not met within this long. */
  timeout_seconds?: number;
}

/**
 * An authored block of text that does no work of its own. Placed before an
 * agent_task (an edge `prompt -> agent_task`), its text layers ABOVE that
 * agent_task's own prompt as the primary instruction - the same layering the
 * operator's run `--input` applies, packaged as an authorable graph node.
 *
 * Routing-only: like a `condition` node it resolves instantly and follows its
 * outgoing edge, creating no Kanban card and running no worker. The text is
 * optional - an empty Prompt node is a no-op pass-through.
 */
export interface PromptNode {
  id: string;
  type: "prompt";
  title?: string;
  description?: string;
  /** The instruction text layered above each agent_task this node feeds. */
  prompt?: string;
}

export type WorkflowNode =
  | AgentTaskNode
  | ScriptNode
  | ConditionNode
  | HumanReviewNode
  | FinishNode
  | WaitNode
  | PromptNode;
