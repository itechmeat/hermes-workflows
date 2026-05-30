// Request/response types for the workflows dashboard routes. The spec/run/plan
// shapes are reused from @hermes-workflows/core via type-only imports (erased at
// build time, so the core runtime is never bundled). We import from the pure
// schema/validation/compiler modules directly rather than the package barrel:
// the barrel also re-exports Bun/sqlite-backed runtime values, which would drag
// the Bun-flavored core sources into the browser typecheck.
import type {
  Workflow,
  Edge,
  Scope,
  ScopeType,
  Trigger,
} from "@hermes-workflows/core/schema/workflow.ts";
import type { WorkflowNode, NodeType, ReviewOption } from "@hermes-workflows/core/schema/nodes.ts";
import type { RunState, RunStatus, NodeStatus } from "@hermes-workflows/core/schema/run.ts";
import type { UiLayout } from "@hermes-workflows/core/schema/ui.ts";
import type {
  ValidationResult,
  ValidationIssue,
} from "@hermes-workflows/core/validation/validateWorkflow.ts";
import type { HermesPlan } from "@hermes-workflows/core/compiler/compileToHermesPlan.ts";

export type {
  Workflow,
  Edge,
  WorkflowNode,
  NodeType,
  ReviewOption,
  Scope,
  ScopeType,
  Trigger,
  UiLayout,
  RunState,
  RunStatus,
  NodeStatus,
  ValidationResult,
  ValidationIssue,
  HermesPlan,
};

/** A loaded spec with its on-disk location (the shape of `GET /workflows/{id}`
 *  and the body persisted by `PUT`). Mirrors core's `SpecDetail`, declared here
 *  because core's definition lives in a Bun-backed runtime module. */
export interface SpecDetail {
  workflow: Workflow;
  ui?: UiLayout;
  path: string;
}

/** One row of `GET /workflows` — the Python list route flattens scope to its
 *  type string and carries the full trigger object. */
export interface WorkflowListItem {
  id: string;
  name: string;
  scope: ScopeType;
  trigger: Trigger;
}

/** One row of `GET /runs` (active runs only). */
export interface RunSummary {
  run_id: string;
  workflow_id: string;
  status: RunStatus;
}

/** Returned by `POST /workflows/{id}/run`. */
export interface RunStartResult {
  run_id: string;
  status: RunStatus;
}

/** Body of `PUT /workflows/{id}`. */
export interface SaveWorkflowBody {
  workflow: Workflow;
  ui?: UiLayout;
}

/** Optional start options for `POST /workflows/{id}/run`. */
export interface RunOptions {
  project_id?: string;
}

export interface O2BStatus {
  connected: boolean;
}
