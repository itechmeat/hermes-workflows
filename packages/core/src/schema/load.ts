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
  Defaults,
  MemoryProviderKind,
} from "./workflow.ts";
import type {
  WorkflowNode,
  AgentTaskNode,
  ScriptNode,
  HumanReviewNode,
  FinishNode,
  ReviewOption,
} from "./nodes.ts";
import { parseUi } from "./ui.ts";
import type { UiLayout } from "./ui.ts";

export class WorkflowParseError extends Error {
  override name = "WorkflowParseError";
}

export interface LoadResult {
  workflow: Workflow;
  ui?: UiLayout;
}

const NODE_TYPES = new Set(["agent_task", "script", "condition", "human_review", "finish"]);
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
  const ui = parseUi(rawUi);
  return ui === undefined ? { workflow } : { workflow, ui };
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
    if (value["timezone"] !== undefined) trigger.timezone = str(value["timezone"], "trigger.timezone");
    return trigger;
  }
  fail("trigger.type must be 'manual' or 'cron'");
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
      if (typeof mem["fail_open"] !== "boolean") fail("defaults.memory.fail_open must be a boolean");
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
    case "human_review":
      return parseHumanReview(value, base, id);
    default:
      return parseFinish(value, base);
  }
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
    if (typeof value["timeout_seconds"] !== "number") fail(`node '${id}'.timeout_seconds must be a number`);
    node.timeout_seconds = value["timeout_seconds"];
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
    if (typeof value["timeout_seconds"] !== "number") fail(`node '${id}'.timeout_seconds must be a number`);
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
      if (!REVIEW_OPTIONS.has(text)) fail(`node '${id}'.options[${i}] is not a valid review option`);
      return text as ReviewOption;
    });
  }
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
    return { type: "node_status", node: str(value["node"], `edges[${index}].condition.node`), equals };
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
