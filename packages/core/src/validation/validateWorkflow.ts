/**
 * Structural and semantic validation of a workflow graph. Produces errors
 * (block execution) and warnings (allowed, but worth surfacing). Pure.
 */

import type { Workflow } from "../schema/workflow.ts";
import { nodeMap, entryNodes, reachableFrom, outgoingEdges } from "../schema/graph.ts";

export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const CRON_TOKEN = /^(\*|\?|\*\/\d+|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;

// The id becomes a filename (`<root>/<id>.workflow.yaml`); a slug charset keeps
// it from escaping the storage root via path traversal.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// An input_mapping value references one prior node's captured output, or a
// human_review gate's operator note (a distinct channel from `.output`).
const INPUT_REF_PATTERN = /^\{\{nodes\.([A-Za-z0-9_-]+)\.(output|review_note)\}\}$/;

// An event_mapping value references a path into the trigger event payload.
const EVENT_REF_PATTERN = /^\{event\.[A-Za-z0-9_.]+\}$/;

// A task_ref is either a literal board task id (slug) or a typed reference to an
// upstream node's surfaced task ids.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TASK_IDS_REF_PATTERN = /^\{\{nodes\.([A-Za-z0-9_-]+)\.output\.task_ids\}\}$/;

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_TOKEN.test(p));
}

export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string): void =>
    void errors.push({ level: "error", code, message });
  const warn = (code: string, message: string): void =>
    void warnings.push({ level: "warning", code, message });

  const nodes = nodeMap(workflow);
  const defaultProfile = workflow.defaults?.profile;

  // Workflow id (it is also the on-disk filename — reject anything non-slug).
  if (!ID_PATTERN.test(workflow.id)) {
    err("invalid_id", `workflow id '${workflow.id}' must match ${String(ID_PATTERN)}`);
  }

  // Unique node ids.
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    if (seen.has(node.id)) err("duplicate_node", `duplicate node id '${node.id}'`);
    seen.add(node.id);
  }

  // agent_task profile presence.
  for (const node of workflow.nodes) {
    if (node.type === "agent_task" && !node.profile && !defaultProfile) {
      err(
        "missing_profile",
        `agent_task '${node.id}' has no profile and defaults.profile is unset`,
      );
    }
  }

  // script command presence (parse rejects a missing/non-string command; an
  // empty or whitespace-only command is a semantic error caught here).
  for (const node of workflow.nodes) {
    if (node.type === "script" && node.command.trim() === "") {
      err("empty_command", `script node '${node.id}' has an empty command`);
    }
  }

  // Trigger.
  if (workflow.trigger.type === "cron" && !isValidCron(workflow.trigger.schedule)) {
    err("invalid_cron", `invalid cron expression '${workflow.trigger.schedule}'`);
  }
  // Event triggers (webhook/github/api): at least one event, and every
  // event_mapping value references the {event.*} namespace.
  if (workflow.trigger.type !== "manual" && workflow.trigger.type !== "cron") {
    const trigger = workflow.trigger;
    if (trigger.events.length === 0) {
      err("empty_events", `${trigger.type} trigger declares no events`);
    }
    for (const [key, ref] of Object.entries(trigger.event_mapping ?? {})) {
      if (!EVENT_REF_PATTERN.test(ref)) {
        err(
          "invalid_event_mapping_ref",
          `trigger.event_mapping.${key} must be of the form '{event.<path>}', got '${ref}'`,
        );
      }
    }
  }

  // Delivery target: any non-empty string is valid (the gateway validates the
  // platform); only an empty/whitespace value is a semantic error.
  if (workflow.deliver !== undefined && workflow.deliver.trim() === "") {
    err("empty_deliver", "deliver is set but empty");
  }

  // Template params: names are the keys surfaces fill by, so they must be unique.
  if (workflow.params !== undefined) {
    const seenParams = new Set<string>();
    for (const param of workflow.params) {
      if (seenParams.has(param.name))
        err("duplicate_param", `duplicate param name '${param.name}'`);
      seenParams.add(param.name);
    }
  }

  // Edge endpoints and condition references.
  for (const [i, edge] of workflow.edges.entries()) {
    if (!nodes.has(edge.from))
      err("unknown_edge_node", `edges[${i}].from '${edge.from}' does not exist`);
    if (!nodes.has(edge.to)) err("unknown_edge_node", `edges[${i}].to '${edge.to}' does not exist`);
    const cond = edge.condition;
    if (cond?.type === "node_status" && !nodes.has(cond.node)) {
      err("unknown_condition_node", `edges[${i}] condition references unknown node '${cond.node}'`);
    }
    if (cond?.type === "review_status" && nodes.get(edge.from)?.type !== "human_review") {
      err(
        "review_condition_source",
        `edges[${i}] review_status condition must originate from a human_review node`,
      );
    }
  }

  // finish nodes must be terminal.
  for (const node of workflow.nodes) {
    if (node.type === "finish" && outgoingEdges(workflow, node.id).length > 0) {
      err("finish_has_outgoing", `finish node '${node.id}' must not have outgoing edges`);
    }
  }

  validateInputMappings(workflow, nodes, err);
  validateParamRefs(workflow, err);
  validateAdopt(workflow, nodes, err);
  validateWait(workflow, nodes, err);

  // Exactly one entry node; at least one finish; reachability.
  const entries = entryNodes(workflow);
  if (entries.length === 0)
    err("no_entry", "workflow has no entry node (check for a cycle with no start)");
  if (entries.length > 1) {
    err(
      "multiple_entries",
      `workflow has multiple entry nodes: ${entries.map((n) => n.id).join(", ")}`,
    );
  }
  if (!workflow.nodes.some((n) => n.type === "finish"))
    err("no_finish", "workflow has no finish node");

  const entry = entries[0];
  if (entry) {
    const reachable = reachableFrom(workflow, entry.id);
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id))
        err("unreachable_node", `node '${node.id}' is unreachable from the entry node`);
    }
  }

  // Branch coverage and cycle warnings.
  validateBranches(workflow, err);
  if (entry && hasCycle(workflow)) {
    warn("cycle", "workflow contains a cycle; ensure it terminates (loop policy is implicit)");
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateBranches(workflow: Workflow, err: (code: string, message: string) => void): void {
  for (const node of workflow.nodes) {
    const edges = outgoingEdges(workflow, node.id);
    const conditioned = edges.filter((e) => e.condition !== undefined);
    if (conditioned.length === 0) continue;
    const hasFallback = edges.some((e) => e.fallback);
    if (hasFallback) continue;

    // node_status branches must cover both outcomes (a missing success/failure
    // path is a real footgun). review_status branches may be partial: an
    // unhandled decision intentionally stops the run.
    const statusEquals = new Set(
      conditioned
        .filter((e) => e.condition?.type === "node_status")
        .map((e) => (e.condition as { equals: string }).equals),
    );
    if (statusEquals.size > 0 && !(statusEquals.has("success") && statusEquals.has("failure"))) {
      err(
        "incomplete_branch",
        `node '${node.id}' branches on node_status but covers neither both outcomes nor a fallback edge`,
      );
    }
  }
}

// input_mapping references: each value is a well-formed reference to an
// ancestor node's output, and each declared placeholder is used in the prompt.
function validateInputMappings(
  workflow: Workflow,
  nodes: ReturnType<typeof nodeMap>,
  err: (code: string, message: string) => void,
): void {
  for (const node of workflow.nodes) {
    if (node.type !== "agent_task" || node.input_mapping === undefined) continue;
    for (const [key, ref] of Object.entries(node.input_mapping)) {
      if (!node.prompt.includes(`{{${key}}}`)) {
        err(
          "unused_input_mapping",
          `node '${node.id}'.input_mapping declares '${key}' but the prompt never references '{{${key}}}'`,
        );
      }
      const match = INPUT_REF_PATTERN.exec(ref);
      if (!match) {
        err(
          "invalid_input_mapping_ref",
          `node '${node.id}'.input_mapping.${key} must be of the form '{{nodes.<id>.output}}' or '{{nodes.<id>.review_note}}', got '${ref}'`,
        );
        continue;
      }
      const source = match[1] as string;
      const channel = match[2] as string;
      if (!nodes.has(source)) {
        err(
          "unknown_input_mapping_node",
          `node '${node.id}'.input_mapping.${key} references unknown node '${source}'`,
        );
        continue;
      }
      if (channel === "review_note" && nodes.get(source)?.type !== "human_review") {
        err(
          "review_note_source",
          `node '${node.id}'.input_mapping.${key} reads '.review_note' from '${source}', which is not a human_review node`,
        );
      }
      if (source === node.id || !reachableFrom(workflow, source).has(node.id)) {
        err(
          "non_ancestor_input_mapping",
          `node '${node.id}'.input_mapping.${key} references '${source}', which is not an ancestor of '${node.id}'`,
        );
      }
    }
  }
}

// {{params.<name>}} references: a node prompt may interpolate a template param,
// substituted with its run value at schedule time. Every referenced name must be
// a declared param, so a typo (or a param referenced by a non-template workflow)
// fails at author time rather than leaving a literal placeholder in the prompt.
const PARAM_REF_PATTERN = /\{\{params\.([A-Za-z0-9_-]+)\}\}/g;

function validateParamRefs(workflow: Workflow, err: (code: string, message: string) => void): void {
  const declared = new Set((workflow.params ?? []).map((p) => p.name));
  for (const node of workflow.nodes) {
    if (node.type !== "agent_task" && node.type !== "prompt") continue;
    const prompt = node.prompt;
    if (!prompt) continue;
    for (const match of prompt.matchAll(PARAM_REF_PATTERN)) {
      const name = match[1] as string;
      if (!declared.has(name)) {
        err(
          "unknown_param_ref",
          `node '${node.id}' references '{{params.${name}}}' but no param '${name}' is declared`,
        );
      }
    }
  }
}

// adopt / task_ref: only an adopt node may carry a task_ref, an adopt node must
// carry one, and the ref is either a literal board id or a typed reference to an
// ancestor node's surfaced task ids.
function validateAdopt(
  workflow: Workflow,
  nodes: ReturnType<typeof nodeMap>,
  err: (code: string, message: string) => void,
): void {
  for (const node of workflow.nodes) {
    if (node.type !== "agent_task") continue;
    const { adopt, task_ref } = node;
    if (task_ref !== undefined && adopt !== true) {
      err("task_ref_without_adopt", `node '${node.id}' has a task_ref but adopt is not set`);
    }
    if (node.review_profile !== undefined && adopt !== true) {
      err(
        "review_profile_without_adopt",
        `node '${node.id}' has a review_profile but is not an adopt node`,
      );
    }
    if (node.sequential === true && adopt !== true) {
      err("sequential_without_adopt", `node '${node.id}' has sequential but is not an adopt node`);
    }
    if (node.stack === true && adopt !== true) {
      err("stack_without_adopt", `node '${node.id}' has stack but is not an adopt node`);
    }
    if (node.branch !== undefined && node.stack !== true) {
      err("branch_without_stack", `node '${node.id}' has a branch but is not a stacked adopt node`);
    }
    if (adopt === true && task_ref === undefined) {
      err("adopt_without_task_ref", `adopt node '${node.id}' has no task_ref to drive`);
      continue;
    }
    if (task_ref === undefined) continue;
    const refMatch = TASK_IDS_REF_PATTERN.exec(task_ref);
    if (refMatch) {
      const source = refMatch[1] as string;
      if (!nodes.has(source)) {
        err(
          "unknown_task_ref_node",
          `node '${node.id}'.task_ref references unknown node '${source}'`,
        );
      } else if (source === node.id || !reachableFrom(workflow, source).has(node.id)) {
        err(
          "non_ancestor_task_ref",
          `node '${node.id}'.task_ref references '${source}', which is not an ancestor of '${node.id}'`,
        );
      }
    } else if (!TASK_ID_PATTERN.test(task_ref)) {
      err(
        "invalid_task_ref",
        `node '${node.id}'.task_ref must be a board task id or '{{nodes.<id>.output.task_ids}}', got '${task_ref}'`,
      );
    }
  }
}

// wait nodes: the github_pr_merged ref is a non-empty literal or a typed
// `{{nodes.<id>.output}}` reference to an ancestor (resolved at poll time).
const WAIT_OUTPUT_REF = /^\{\{nodes\.([A-Za-z0-9_-]+)\.output\}\}$/;

function validateWait(
  workflow: Workflow,
  nodes: ReturnType<typeof nodeMap>,
  err: (code: string, message: string) => void,
): void {
  for (const node of workflow.nodes) {
    if (node.type !== "wait") continue;
    // Trim first so detection matches the runtime resolver (which strips before
    // matching the template) — a padded "  {{…}}" must not slip through as literal.
    const ref = node.wait_for.github_pr_merged.trim();
    if (ref === "") {
      err("empty_wait_ref", `wait node '${node.id}'.wait_for.github_pr_merged is empty`);
      continue;
    }
    if (!ref.startsWith("{{")) continue; // a literal PR ref (url/number)
    const match = WAIT_OUTPUT_REF.exec(ref);
    if (!match) {
      err(
        "invalid_wait_ref",
        `wait node '${node.id}'.wait_for.github_pr_merged must be a PR ref or '{{nodes.<id>.output}}', got '${ref}'`,
      );
      continue;
    }
    const source = match[1] as string;
    if (!nodes.has(source)) {
      err(
        "unknown_wait_ref_node",
        `wait node '${node.id}'.wait_for references unknown node '${source}'`,
      );
    } else if (source === node.id || !reachableFrom(workflow, source).has(node.id)) {
      err(
        "non_ancestor_wait_ref",
        `wait node '${node.id}'.wait_for references '${source}', which is not an ancestor of '${node.id}'`,
      );
    }
  }
}

function hasCycle(workflow: Workflow): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const edge of outgoingEdges(workflow, id)) {
      if (visit(edge.to)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return workflow.nodes.some((n) => visit(n.id));
}
