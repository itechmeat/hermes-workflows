/**
 * Public entry point for the Hermes Workflows core engine.
 *
 * The core is intentionally side-effect free: it parses, validates, compiles,
 * and advances workflow graphs as pure data transforms. All Hermes I/O lives
 * in the Python bridge.
 */

export const CORE_VERSION = "0.1.0";

// Schema
export type {
  NodeType,
  ReviewOption,
  WorkspaceKind,
  AgentTaskNode,
  ScriptNode,
  ConditionNode,
  HumanReviewNode,
  FinishNode,
  WorkflowNode,
} from "./schema/nodes.ts";
export type {
  ScopeType,
  Scope,
  ManualTrigger,
  CronTrigger,
  EventTrigger,
  EventTriggerType,
  Trigger,
  MemoryProviderKind,
  MemoryDefaults,
  Defaults,
  NodeStatusCondition,
  ReviewStatusCondition,
  EdgeCondition,
  Edge,
  Workflow,
} from "./schema/workflow.ts";
export { isWorkflowEnabled, EVENT_TRIGGER_TYPES } from "./schema/workflow.ts";
export type { RunStatus, NodeStatus, NodeOutcome, NodeRunState, RunState } from "./schema/run.ts";

// Loading
export { parseWorkflow, fromObject, WorkflowParseError } from "./schema/load.ts";
export type { LoadResult } from "./schema/load.ts";
export { parseUi } from "./schema/ui.ts";
export type { UiLayout, XyflowLayout, XyflowNodeLayout, Viewport } from "./schema/ui.ts";

// Serialization
export { serializeWorkflow } from "./serialize/serializeWorkflow.ts";
export { specSha } from "./serialize/specSha.ts";
export {
  exportTemplate,
  templateCacheKey,
  templateRevision,
  generationRequest,
  TEMPLATE_FORMAT,
  GENERATOR_VERSION,
} from "./templates/exportTemplate.ts";
export type {
  TemplateBundle,
  TemplateVersion,
  TemplatePlaceholder,
  InventoryItem,
  GuideHints,
  NodeHint,
  GenerationRequest,
  ExportTemplateOptions,
  PrereqLinks,
} from "./templates/exportTemplate.ts";

// Template parameters + per-surface emitters (host-mirror of blueprint_catalog)
export {
  paramFormSchema,
  paramSlashCommand,
  paramDeeplink,
  catalogEntry,
  agentSeed,
  fillParams,
  ParamFillError,
} from "./templates/params.ts";
export type {
  ParamType,
  ParamValue,
  WorkflowParam,
  WorkflowTemplate,
  ParamFormField,
  CatalogEntry,
} from "./templates/params.ts";

// Graph helpers
export {
  nodeMap,
  outgoingEdges,
  incomingEdges,
  entryNodes,
  reachableFrom,
} from "./schema/graph.ts";

// Validation
export { validateWorkflow } from "./validation/validateWorkflow.ts";
export type {
  ValidationResult,
  ValidationIssue,
  IssueLevel,
} from "./validation/validateWorkflow.ts";

// Runtime
export { evaluateCondition } from "./runtime/conditions.ts";
export {
  createRunState,
  transitionRun,
  transitionNode,
  canTransitionRun,
  canTransitionNode,
  IllegalTransitionError,
} from "./runtime/state.ts";
export { advance, selectOutgoing } from "./runtime/advance.ts";
export type { AdvanceResult } from "./runtime/advance.ts";
export { cancelRun, retryRun, RetryError } from "./runtime/runMutations.ts";

// Compiler
export { compileToHermesPlan } from "./compiler/compileToHermesPlan.ts";
export type {
  HermesPlan,
  CompiledKanbanTask,
  CompiledScript,
  CompiledCronJob,
} from "./compiler/compileToHermesPlan.ts";

// Persistence
export { openRunsDatabase } from "./runtime/db/connection.ts";
export { SCHEMA_SQL } from "./runtime/db/schema.ts";
export { ActiveRunExistsError, RunRepository } from "./runtime/db/runRepository.ts";
export type { ActiveRunRef, RunMeta, RunSummary, LatestRun } from "./runtime/db/runRepository.ts";
export {
  SpecStore,
  SpecValidationError,
  SpecExistsError,
  chooseWriteRoot,
} from "./runtime/specStore.ts";
export type { SpecSummary, SpecDetail, WriteRoots } from "./runtime/specStore.ts";
export { ArtifactStore } from "./runtime/artifacts.ts";

// Memory
export type {
  WorkflowMemoryProvider,
  WorkflowContext,
  WorkflowContextRequest,
  WorkflowMemoryEvent,
  WorkflowMemoryEventKind,
  WorkflowRetrospective,
} from "./memory/MemoryProvider.ts";
export { NoopMemoryProvider } from "./memory/NoopMemoryProvider.ts";
export { O2BCLIProvider, defaultRunner } from "./memory/O2BCLIProvider.ts";
export type { CliRunner } from "./memory/O2BCLIProvider.ts";
export { redactSecrets } from "./memory/redact.ts";
export { FailOpenMemoryProvider } from "./memory/FailOpenMemoryProvider.ts";
export { RedactingMemoryProvider } from "./memory/RedactingMemoryProvider.ts";
export { buildRetrospective } from "./memory/retrospective.ts";
export type { RetrospectiveMeta } from "./memory/retrospective.ts";
export { resolveMemoryProvider } from "./memory/resolveProvider.ts";
export { cmdMemoryEvent, cmdMemoryRetro, cmdMemoryRetroFromRun } from "./cli/commands.ts";
