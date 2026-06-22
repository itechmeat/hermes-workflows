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
import type { ParamValue } from "@hermes-workflows/core/templates/params.ts";
import type {
  RunState,
  RunStatus,
  NodeRunState,
  NodeStatus,
  NodeTelemetry,
  NodeTelemetryApproval,
} from "@hermes-workflows/core/schema/run.ts";
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
  NodeRunState,
  NodeStatus,
  NodeTelemetry,
  NodeTelemetryApproval,
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
 *  type string and carries the full trigger object. The Templates page also
 *  shows `enabled` plus best-effort run/schedule columns: `last_run_at`
 *  (epoch seconds) / `last_status` from the workflow's most recent run, and
 *  `next_run_at` from its cron schedule (null when it has none / no run yet). */
export interface WorkflowListItem {
  id: string;
  name: string;
  scope: ScopeType;
  trigger: Trigger;
  enabled: boolean;
  last_run_at: number | null;
  last_status: RunStatus | null;
  next_run_at: string | null;
}

/** One row of `GET /runs` — the Runs-page columns. `scope=active` (default)
 *  lists in-flight runs; `scope=all` adds finished ones. `started_at`/`finished_at`
 *  are epoch seconds (null until set); `duration` is `finished_at - started_at`
 *  in seconds when both are known. */
export interface RunSummary {
  run_id: string;
  workflow_id: string;
  project_id: string | null;
  status: RunStatus;
  current_node: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration: number | null;
  /** Sum of per-node telemetry tokens; null until any node has telemetry. */
  total_tokens: number | null;
}

/** Returned by `GET /runs/{id}/export` — the full run-load bundle wrapped in a
 *  JSON envelope so it travels over the host's JSON-only `fetchJSON`. A traced
 *  run (observability.trace_enabled) additionally carries its JSONL timeline,
 *  downloaded as a second file. */
export interface ExportedRun {
  run_id: string;
  filename: string;
  json: RunState;
  trace?: string;
  trace_filename?: string;
}

/** One row of `GET /schedules` — a workflow's native Hermes cron schedule.
 *  Hermes cron interprets schedules in UTC. `last_run`/`next_run` are ISO
 *  timestamps (null until known). */
export interface ScheduleListItem {
  workflow_id: string;
  cron_expression: string | null;
  timezone: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  hermes_cron_id: string;
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

/** Body of `POST /workflows` — same shape as a save, but the route refuses to
 *  overwrite an existing id (409). */
export type CreateWorkflowBody = SaveWorkflowBody;

/** Returned by `DELETE /workflows/{id}`. */
export interface DeleteResult {
  deleted: boolean;
}

/** Returned by `GET /workflows/{id}/export` — the canonical on-disk YAML wrapped
 *  in a JSON envelope so it travels over the host's JSON-only `fetchJSON`. */
export interface ExportedWorkflow {
  id: string;
  filename: string;
  yaml: string;
}

/** The "export as template" bundle: the de-bound spec plus its adaptation
 *  guide, both as text so they download over the JSON-only channel. */
export interface ExportedTemplate {
  id: string;
  cached: boolean;
  revision: string;
  human_version: string;
  spec_sha: string;
  yaml_filename: string;
  yaml: string;
  md_filename: string;
  md: string;
}

/** Optional start options for `POST /workflows/{id}/run`. */
export interface RunOptions {
  project_id?: string;
  /** Free-form operator input, layered above every agent_task prompt at highest
   *  priority for this run (overrides conflicting node instructions, augments
   *  the rest). */
  input?: string;
  /** Resolved template parameter values for a parameterized workflow, validated
   *  by the core against the declared params and substituted as `{{params.X}}`
   *  into node prompts. Omitted for a non-template workflow. */
  params?: Record<string, ParamValue>;
}

export interface O2BStatus {
  /** Installed AND configured — actually usable. Drives the badge colour. */
  connected: boolean;
  /** CLI present on the system. Drives the indicator's link target:
   *  installed -> host `/plugins`; not installed -> the project repo. */
  installed: boolean;
}

/** Models offered by one authenticated provider, for the agent_task model
 *  picker. `provider` is the slug used in `model@provider` values; `label` is
 *  its display name. */
export interface ModelGroup {
  provider: string;
  label: string;
  models: string[];
}

/** A single settings value (the Settings page handles string / int / bool). */
export type SettingsValue = string | number | boolean;

/** Effective settings: a flat map of field key → value. */
export type WorkflowSettings = Record<string, SettingsValue>;

/** One field descriptor in the settings schema. `enforced` is false for knobs
 *  persisted/displayed but not yet honoured by the engine. */
export interface SettingsField {
  key: string;
  type: "string" | "int" | "bool" | "enum";
  enforced: boolean;
  default: SettingsValue;
  options?: string[];
}

export interface SettingsGroup {
  key: string;
  label: string;
  fields: SettingsField[];
}

export interface SettingsSchema {
  namespace: string;
  groups: SettingsGroup[];
}

/** Body of `GET`/`PUT /settings` responses — effective values plus the schema. */
export interface SettingsResponse {
  values: WorkflowSettings;
  schema: SettingsSchema;
}
