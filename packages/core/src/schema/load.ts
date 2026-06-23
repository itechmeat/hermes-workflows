/**
 * Parse a workflow spec (YAML or JSON) into a typed `Workflow`, separating the
 * `ui` layout block from execution data. Structural shape errors are raised
 * here; semantic graph rules live in `validateWorkflow`.
 *
 * A spec without a `ui` block must load and be fully executable.
 */

import type {
  Workflow,
  Edge,
  EdgeCondition,
  Scope,
  Trigger,
  EventTrigger,
  EventTriggerType,
  Defaults,
  NotificationDefaults,
  MemoryProviderKind,
} from "./workflow.ts";
import { EVENT_TRIGGER_TYPES } from "./workflow.ts";
import type {
  WorkflowNode,
  AgentTaskNode,
  ScriptNode,
  HumanReviewNode,
  FinishNode,
  ReviewOption,
  WaitNode,
  PromptNode,
} from "./nodes.ts";
import { parseUi } from "./ui.ts";
import type { UiLayout } from "./ui.ts";
import type { ParamType, ParamValue, WorkflowParam } from "../templates/params.ts";

export class WorkflowParseError extends Error {
  override name = "WorkflowParseError";
}

export interface LoadResult {
  workflow: Workflow;
  ui?: UiLayout;
}

const NODE_TYPES = new Set([
  "agent_task",
  "script",
  "condition",
  "human_review",
  "finish",
  "wait",
  "prompt",
]);
const SCOPE_TYPES = new Set(["global", "project", "projects"]);
const REVIEW_OPTIONS = new Set(["approved", "rejected", "needs_changes"]);
const MEMORY_PROVIDERS = new Set(["auto", "open_second_brain", "none"]);

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new WorkflowParseError(message);
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  return value;
}

/** Parse a spec from raw text (YAML superset also accepts JSON). */
export function parseWorkflow(source: string): LoadResult {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(source);
  } catch (err) {
    fail(`failed to parse spec: ${(err as Error).message}`);
  }
  return fromObject(raw);
}

/** Build a typed workflow from an already-parsed object. */
export function fromObject(raw: unknown): LoadResult {
  if (!isRecord(raw)) fail("workflow spec must be a mapping");
  const { ui: rawUi, ...rest } = raw;
  const enabled = parseEnabled(rest["enabled"]);
  const workflow: Workflow = {
    id: str(rest["id"], "id"),
    name: str(rest["name"], "name"),
    version: parseVersion(rest["version"]),
    // Keep the key absent (not `enabled: undefined`) when unspecified so the
    // round-trip stays lossless for specs that never opt into the flag.
    ...(enabled === undefined ? {} : { enabled }),
    scope: parseScope(rest["scope"]),
    trigger: parseTrigger(rest["trigger"]),
    defaults: parseDefaults(rest["defaults"]),
    nodes: parseNodes(rest["nodes"]),
    edges: parseEdges(rest["edges"]),
  };
  // Where the run result is delivered (DeliveryTarget syntax or "origin"). Any
  // non-empty string is structurally valid; the gateway validates the platform.
  if (rest["deliver"] !== undefined) workflow.deliver = str(rest["deliver"], "deliver");
  // Notification policy (per-card Kanban subscription opt-out).
  if (rest["notifications"] !== undefined) {
    workflow.notifications = parseNotifications(rest["notifications"]);
  }
  // Typed template parameters (single source of truth for the surface emitters).
  if (rest["params"] !== undefined) workflow.params = parseParams(rest["params"]);
  const ui = parseUi(rawUi);
  return ui === undefined ? { workflow } : { workflow, ui };
}

const PARAM_TYPES: readonly ParamType[] = ["text", "enum", "int", "bool"];

function isParamType(type: string): type is ParamType {
  return PARAM_TYPES.some((t) => t === type);
}

function parseScalar(value: unknown, where: string): ParamValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  fail(`${where} must be a string, number, or boolean`);
}

function parseParams(value: unknown): WorkflowParam[] {
  if (!Array.isArray(value)) fail("params must be a list");
  return value.map((param, i) => parseParam(param, i));
}

function parseParam(value: unknown, index: number): WorkflowParam {
  if (!isRecord(value)) fail(`params[${index}] must be a mapping`);
  const type = str(value["type"], `params[${index}].type`);
  if (!isParamType(type)) fail(`params[${index}].type must be one of ${PARAM_TYPES.join(", ")}`);
  const param: WorkflowParam = {
    name: str(value["name"], `params[${index}].name`),
    type,
    label: str(value["label"], `params[${index}].label`),
  };
  // `options` is enum-only; reject it on other types at the schema boundary.
  if (value["options"] !== undefined) {
    if (type !== "enum") fail(`params[${index}].options is only valid for an enum param`);
    if (!Array.isArray(value["options"])) fail(`params[${index}].options must be a list`);
    param.options = value["options"].map((o, j) => str(o, `params[${index}].options[${j}]`));
  }
  if (value["optional"] !== undefined) {
    if (typeof value["optional"] !== "boolean") fail(`params[${index}].optional must be a boolean`);
    param.optional = value["optional"];
  }
  // `required` is the explicit inverse alias of `optional` (so a template can
  // read `required: true` rather than rely on the absence of `optional`). It
  // maps onto the single `optional` source the engine checks; declaring both is
  // a contradiction and fails at load.
  if (value["required"] !== undefined) {
    if (typeof value["required"] !== "boolean") fail(`params[${index}].required must be a boolean`);
    if (value["optional"] !== undefined) {
      fail(`params[${index}] declares both optional and required — keep one`);
    }
    param.optional = !value["required"];
  }
  if (value["strict"] !== undefined) {
    if (typeof value["strict"] !== "boolean") fail(`params[${index}].strict must be a boolean`);
    param.strict = value["strict"];
  }
  if (value["help"] !== undefined) param.help = str(value["help"], `params[${index}].help`);
  // The default must match the declared type (so a malformed template fails at
  // load, not later in the emitters), and a strict enum's default must be one
  // of its options.
  if (value["default"] !== undefined) {
    param.default = parseDefault(type, value["default"], param, index);
  }
  return param;
}

function parseDefault(
  type: ParamType,
  raw: unknown,
  param: WorkflowParam,
  index: number,
): ParamValue {
  const def = parseScalar(raw, `params[${index}].default`);
  if (type === "int" && !(typeof def === "number" && Number.isInteger(def))) {
    fail(`params[${index}].default must be an integer for an int param`);
  }
  if (type === "bool" && typeof def !== "boolean") {
    fail(`params[${index}].default must be a boolean for a bool param`);
  }
  if ((type === "text" || type === "enum") && typeof def !== "string") {
    fail(`params[${index}].default must be a string for a ${type} param`);
  }
  if (
    type === "enum" &&
    param.strict !== false &&
    param.options !== undefined &&
    !param.options.includes(String(def))
  ) {
    fail(`params[${index}].default must be one of options for a strict enum param`);
  }
  return def;
}

function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("enabled must be a boolean");
  return value;
}

function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("version must be an integer");
  }
  return value;
}

function parseScope(value: unknown): Scope {
  if (!isRecord(value)) fail("scope must be a mapping");
  const type = str(value["type"], "scope.type");
  if (!SCOPE_TYPES.has(type)) fail(`scope.type must be one of ${[...SCOPE_TYPES].join(", ")}`);
  const scope: Scope = { type: type as Scope["type"] };
  if (value["projects"] !== undefined) {
    if (!Array.isArray(value["projects"])) fail("scope.projects must be a list");
    scope.projects = value["projects"].map((p, i) => str(p, `scope.projects[${i}]`));
  }
  return scope;
}

function parseTrigger(value: unknown): Trigger {
  if (!isRecord(value)) fail("trigger must be a mapping");
  const type = str(value["type"], "trigger.type");
  if (type === "manual") return { type: "manual" };
  if (type === "cron") {
    const trigger: Trigger = { type: "cron", schedule: str(value["schedule"], "trigger.schedule") };
    if (value["timezone"] !== undefined)
      trigger.timezone = str(value["timezone"], "trigger.timezone");
    return trigger;
  }
  if (isEventTriggerType(type)) {
    return parseEventTrigger(value, type);
  }
  fail("trigger.type must be 'manual', 'cron', 'webhook', 'github', or 'api'");
}

function isEventTriggerType(type: string): type is EventTriggerType {
  return EVENT_TRIGGER_TYPES.some((t) => t === type);
}

function parseEventTrigger(value: Rec, type: EventTriggerType): EventTrigger {
  if (!Array.isArray(value["events"])) fail("trigger.events must be a list");
  const trigger: EventTrigger = {
    type,
    events: value["events"].map((e, i) => str(e, `trigger.events[${i}]`)),
  };
  if (value["event_mapping"] !== undefined) {
    if (!isRecord(value["event_mapping"])) fail("trigger.event_mapping must be a mapping");
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(value["event_mapping"])) {
      mapping[k] = str(v, `trigger.event_mapping.${k}`);
    }
    trigger.event_mapping = mapping;
  }
  return trigger;
}

function parseNotifications(value: unknown): NotificationDefaults {
  if (!isRecord(value)) fail("notifications must be a mapping");
  const out: NotificationDefaults = {};
  if (value["subscribe_cards"] !== undefined) {
    if (typeof value["subscribe_cards"] !== "boolean") {
      fail("notifications.subscribe_cards must be a boolean");
    }
    out.subscribe_cards = value["subscribe_cards"];
  }
  return out;
}

function parseDefaults(value: unknown): Defaults | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail("defaults must be a mapping");
  const defaults: Defaults = {};
  if (value["profile"] !== undefined) defaults.profile = str(value["profile"], "defaults.profile");
  if (value["model"] !== undefined) defaults.model = str(value["model"], "defaults.model");
  if (value["max_retries"] !== undefined) {
    if (typeof value["max_retries"] !== "number") fail("defaults.max_retries must be a number");
    defaults.max_retries = value["max_retries"];
  }
  if (value["memory"] !== undefined) {
    if (!isRecord(value["memory"])) fail("defaults.memory must be a mapping");
    const mem = value["memory"];
    defaults.memory = {};
    if (mem["provider"] !== undefined) {
      const provider = str(mem["provider"], "defaults.memory.provider");
      if (!MEMORY_PROVIDERS.has(provider)) {
        fail(`defaults.memory.provider must be one of ${[...MEMORY_PROVIDERS].join(", ")}`);
      }
      defaults.memory.provider = provider as MemoryProviderKind;
    }
    if (mem["fail_open"] !== undefined) {
      if (typeof mem["fail_open"] !== "boolean")
        fail("defaults.memory.fail_open must be a boolean");
      defaults.memory.fail_open = mem["fail_open"];
    }
  }
  return defaults;
}

function parseNodes(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value)) fail("nodes must be a list");
  if (value.length === 0) fail("nodes must not be empty");
  return value.map((node, i) => parseNode(node, i));
}

function parseNode(value: unknown, index: number): WorkflowNode {
  if (!isRecord(value)) fail(`nodes[${index}] must be a mapping`);
  const id = str(value["id"], `nodes[${index}].id`);
  const type = str(value["type"], `node '${id}'.type`);
  if (!NODE_TYPES.has(type)) fail(`node '${id}'.type must be one of ${[...NODE_TYPES].join(", ")}`);
  const base = { id, ...optionalText(value, id) };
  switch (type) {
    case "agent_task":
      return parseAgentTask(value, base, id);
    case "script":
      return parseScript(value, base, id);
    case "condition":
      return { ...base, type: "condition" };
    case "prompt":
      return parsePrompt(value, base, id);
    case "human_review":
      return parseHumanReview(value, base, id);
    case "wait":
      return parseWait(value, base, id);
    default:
      return parseFinish(value, base);
  }
}

function parseWait(value: Rec, base: { id: string }, id: string): WaitNode {
  const raw = value["wait_for"];
  if (!isRecord(raw)) fail(`node '${id}'.wait_for must be a mapping`);
  if (typeof raw["github_pr_merged"] !== "string") {
    fail(`node '${id}'.wait_for must declare a string 'github_pr_merged' (the PR ref)`);
  }
  const node: WaitNode = {
    ...base,
    type: "wait",
    wait_for: { github_pr_merged: raw["github_pr_merged"] },
  };
  if (value["timeout_seconds"] !== undefined) {
    if (typeof value["timeout_seconds"] !== "number")
      fail(`node '${id}'.timeout_seconds must be a number`);
    node.timeout_seconds = value["timeout_seconds"];
  }
  return node;
}

function optionalText(value: Rec, id: string): { title?: string; description?: string } {
  const out: { title?: string; description?: string } = {};
  if (value["title"] !== undefined) out.title = str(value["title"], `node '${id}'.title`);
  if (value["description"] !== undefined) {
    out.description = str(value["description"], `node '${id}'.description`);
  }
  return out;
}

function parseAgentTask(value: Rec, base: { id: string }, id: string): AgentTaskNode {
  const node: AgentTaskNode = {
    ...base,
    type: "agent_task",
    prompt: str(value["prompt"], `node '${id}'.prompt`),
  };
  if (value["profile"] !== undefined) node.profile = str(value["profile"], `node '${id}'.profile`);
  if (value["model"] !== undefined) node.model = str(value["model"], `node '${id}'.model`);
  if (value["workdir"] !== undefined) node.workdir = str(value["workdir"], `node '${id}'.workdir`);
  if (value["skills"] !== undefined) {
    if (!Array.isArray(value["skills"])) fail(`node '${id}'.skills must be a list`);
    node.skills = value["skills"].map((s, i) => str(s, `node '${id}'.skills[${i}]`));
  }
  if (value["workspace"] !== undefined) {
    if (!isRecord(value["workspace"])) fail(`node '${id}'.workspace must be a mapping`);
    const kind = str(value["workspace"]["type"], `node '${id}'.workspace.type`);
    if (kind !== "scratch" && kind !== "worktree") {
      fail(`node '${id}'.workspace.type must be 'scratch' or 'worktree'`);
    }
    node.workspace = { type: kind };
  }
  if (value["input_mapping"] !== undefined) {
    if (!isRecord(value["input_mapping"])) fail(`node '${id}'.input_mapping must be a mapping`);
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(value["input_mapping"])) {
      mapping[k] = str(v, `node '${id}'.input_mapping.${k}`);
    }
    node.input_mapping = mapping;
  }
  if (value["max_retries"] !== undefined) {
    if (typeof value["max_retries"] !== "number") fail(`node '${id}'.max_retries must be a number`);
    node.max_retries = value["max_retries"];
  }
  if (value["timeout_seconds"] !== undefined) {
    if (typeof value["timeout_seconds"] !== "number")
      fail(`node '${id}'.timeout_seconds must be a number`);
    node.timeout_seconds = value["timeout_seconds"];
  }
  if (value["adopt"] !== undefined) {
    if (typeof value["adopt"] !== "boolean") fail(`node '${id}'.adopt must be a boolean`);
    node.adopt = value["adopt"];
  }
  if (value["task_ref"] !== undefined) {
    node.task_ref = str(value["task_ref"], `node '${id}'.task_ref`);
  }
  if (value["review_profile"] !== undefined) {
    node.review_profile = str(value["review_profile"], `node '${id}'.review_profile`);
  }
  if (value["sequential"] !== undefined) {
    if (typeof value["sequential"] !== "boolean") fail(`node '${id}'.sequential must be a boolean`);
    node.sequential = value["sequential"];
  }
  if (value["stack"] !== undefined) {
    if (typeof value["stack"] !== "boolean") fail(`node '${id}'.stack must be a boolean`);
    node.stack = value["stack"];
  }
  if (value["branch"] !== undefined) {
    node.branch = str(value["branch"], `node '${id}'.branch`);
  }
  if (value["notify_completion"] !== undefined) {
    if (typeof value["notify_completion"] !== "boolean") {
      fail(`node '${id}'.notify_completion must be a boolean`);
    }
    node.notify_completion = value["notify_completion"];
  }
  if (value["board"] !== undefined) {
    if (typeof value["board"] !== "boolean") fail(`node '${id}'.board must be a boolean`);
    node.board = value["board"];
  }
  return node;
}

function parseScript(value: Rec, base: { id: string }, id: string): ScriptNode {
  const node: ScriptNode = {
    ...base,
    type: "script",
    command: str(value["command"], `node '${id}'.command`),
  };
  if (value["workdir"] !== undefined) node.workdir = str(value["workdir"], `node '${id}'.workdir`);
  if (value["timeout_seconds"] !== undefined) {
    if (typeof value["timeout_seconds"] !== "number")
      fail(`node '${id}'.timeout_seconds must be a number`);
    node.timeout_seconds = value["timeout_seconds"];
  }
  if (value["env"] !== undefined) {
    if (!Array.isArray(value["env"])) fail(`node '${id}'.env must be a list`);
    node.env = value["env"].map((e, i) => str(e, `node '${id}'.env[${i}]`));
  }
  return node;
}

function parseHumanReview(value: Rec, base: { id: string }, id: string): HumanReviewNode {
  const node: HumanReviewNode = { ...base, type: "human_review" };
  if (value["options"] !== undefined) {
    if (!Array.isArray(value["options"])) fail(`node '${id}'.options must be a list`);
    node.options = value["options"].map((opt, i) => {
      const text = str(opt, `node '${id}'.options[${i}]`);
      if (!REVIEW_OPTIONS.has(text))
        fail(`node '${id}'.options[${i}] is not a valid review option`);
      return text as ReviewOption;
    });
  }
  return node;
}

function parsePrompt(value: Rec, base: { id: string }, id: string): PromptNode {
  const node: PromptNode = { ...base, type: "prompt" };
  // The text is optional; keep the key absent when unspecified so the round-trip
  // stays lossless for a bare pass-through Prompt node.
  if (value["prompt"] !== undefined) node.prompt = str(value["prompt"], `node '${id}'.prompt`);
  return node;
}

function parseFinish(value: Rec, base: { id: string }): FinishNode {
  const node: FinishNode = { ...base, type: "finish" };
  if (value["outcome"] !== undefined) {
    const outcome = str(value["outcome"], "finish.outcome");
    if (outcome !== "success" && outcome !== "failure") {
      fail("finish.outcome must be 'success' or 'failure'");
    }
    node.outcome = outcome;
  }
  return node;
}

function parseEdges(value: unknown): Edge[] {
  if (!Array.isArray(value)) fail("edges must be a list");
  return value.map((edge, i) => parseEdge(edge, i));
}

function parseEdge(value: unknown, index: number): Edge {
  if (!isRecord(value)) fail(`edges[${index}] must be a mapping`);
  const edge: Edge = {
    from: str(value["from"], `edges[${index}].from`),
    to: str(value["to"], `edges[${index}].to`),
  };
  if (value["fallback"] !== undefined) {
    if (typeof value["fallback"] !== "boolean") fail(`edges[${index}].fallback must be a boolean`);
    edge.fallback = value["fallback"];
  }
  if (value["condition"] !== undefined) edge.condition = parseCondition(value["condition"], index);
  return edge;
}

function parseCondition(value: unknown, index: number): EdgeCondition {
  if (!isRecord(value)) fail(`edges[${index}].condition must be a mapping`);
  const type = str(value["type"], `edges[${index}].condition.type`);
  if (type === "node_status") {
    const equals = str(value["equals"], `edges[${index}].condition.equals`);
    if (equals !== "success" && equals !== "failure") {
      fail(`edges[${index}].condition.equals must be 'success' or 'failure'`);
    }
    return {
      type: "node_status",
      node: str(value["node"], `edges[${index}].condition.node`),
      equals,
    };
  }
  if (type === "review_status") {
    const equals = str(value["equals"], `edges[${index}].condition.equals`);
    if (!REVIEW_OPTIONS.has(equals)) {
      fail(`edges[${index}].condition.equals must be a valid review option`);
    }
    return { type: "review_status", equals: equals as ReviewOption };
  }
  fail(`edges[${index}].condition.type must be 'node_status' or 'review_status'`);
}
