/**
 * Workflow-level spec types: scope, trigger, conditions, edges, and the
 * top-level Workflow. Field names mirror the on-disk spec 1:1.
 */

import type { WorkflowNode } from "./nodes.ts";
import type { WorkflowParam } from "../templates/params.ts";

export type ScopeType = "global" | "project" | "projects";

export interface Scope {
  type: ScopeType;
  /** Project ids this workflow is bound to (for `project` / `projects`). */
  projects?: string[];
}

export interface ManualTrigger {
  type: "manual";
}

export interface CronTrigger {
  type: "cron";
  /** A 5-field cron expression interpreted in `timezone`. */
  schedule: string;
  timezone?: string;
}

export type Trigger = ManualTrigger | CronTrigger;

export type MemoryProviderKind = "auto" | "open_second_brain" | "none";

export interface MemoryDefaults {
  provider?: MemoryProviderKind;
  fail_open?: boolean;
}

export interface Defaults {
  profile?: string;
  model?: string;
  max_retries?: number;
  memory?: MemoryDefaults;
}

/** Branch on whether a referenced node finished with success or failure. */
export interface NodeStatusCondition {
  type: "node_status";
  node: string;
  equals: "success" | "failure";
}

/** Branch on the decision made at the edge's source human_review node. */
export interface ReviewStatusCondition {
  type: "review_status";
  equals: "approved" | "rejected" | "needs_changes";
}

export type EdgeCondition = NodeStatusCondition | ReviewStatusCondition;

export interface Edge {
  from: string;
  to: string;
  /** When set, this edge is taken only if the condition evaluates true. */
  condition?: EdgeCondition;
  /** When true, this edge is taken only if no conditioned sibling matched. */
  fallback?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  /**
   * Whether the workflow is active. Absent means enabled, so existing specs are
   * unchanged. A disabled workflow rejects manual runs and pauses its cron job.
   */
  enabled?: boolean;
  scope: Scope;
  trigger: Trigger;
  defaults?: Defaults;
  /**
   * Typed parameters for a workflow used as a template (mirrors the host
   * blueprint slots). The single source of truth for the per-surface emitters
   * in `templates/params.ts`; absent for a non-template workflow.
   */
  params?: WorkflowParam[];
  /**
   * Where the run's result is delivered, in Hermes `DeliveryTarget` syntax
   * (`telegram:-100123:42`, `discord`, `email`, `local`, …) or the literal
   * `"origin"` (the chat the run came from, else the configured default).
   * Absent leaves today's run-lifecycle notices unchanged. Any non-empty string
   * is accepted; the gateway validates the platform downstream (mirroring the
   * host blueprint `deliver` slot, which is non-strict).
   */
  deliver?: string;
  nodes: WorkflowNode[];
  edges: Edge[];
}

/** A workflow is enabled unless `enabled` is explicitly `false`. */
export function isWorkflowEnabled(workflow: Pick<Workflow, "enabled">): boolean {
  return workflow.enabled !== false;
}
