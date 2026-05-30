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

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_TOKEN.test(p));
}

export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string): void => void errors.push({ level: "error", code, message });
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
      err("missing_profile", `agent_task '${node.id}' has no profile and defaults.profile is unset`);
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

  // Edge endpoints and condition references.
  for (const [i, edge] of workflow.edges.entries()) {
    if (!nodes.has(edge.from)) err("unknown_edge_node", `edges[${i}].from '${edge.from}' does not exist`);
    if (!nodes.has(edge.to)) err("unknown_edge_node", `edges[${i}].to '${edge.to}' does not exist`);
    const cond = edge.condition;
    if (cond?.type === "node_status" && !nodes.has(cond.node)) {
      err("unknown_condition_node", `edges[${i}] condition references unknown node '${cond.node}'`);
    }
    if (cond?.type === "review_status" && nodes.get(edge.from)?.type !== "human_review") {
      err("review_condition_source", `edges[${i}] review_status condition must originate from a human_review node`);
    }
  }

  // finish nodes must be terminal.
  for (const node of workflow.nodes) {
    if (node.type === "finish" && outgoingEdges(workflow, node.id).length > 0) {
      err("finish_has_outgoing", `finish node '${node.id}' must not have outgoing edges`);
    }
  }

  // Exactly one entry node; at least one finish; reachability.
  const entries = entryNodes(workflow);
  if (entries.length === 0) err("no_entry", "workflow has no entry node (check for a cycle with no start)");
  if (entries.length > 1) {
    err("multiple_entries", `workflow has multiple entry nodes: ${entries.map((n) => n.id).join(", ")}`);
  }
  if (!workflow.nodes.some((n) => n.type === "finish")) err("no_finish", "workflow has no finish node");

  const entry = entries[0];
  if (entry) {
    const reachable = reachableFrom(workflow, entry.id);
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) err("unreachable_node", `node '${node.id}' is unreachable from the entry node`);
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
