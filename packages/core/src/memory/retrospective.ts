/**
 * Build the §22.6 run retrospective as markdown from a finished run. Pure and
 * deterministic: given the same workflow + run state it renders the same
 * document, so it is unit-testable and safe to call fail-open from the engine.
 *
 * The retrospective is what the run leaves behind in long-term memory (Open
 * Second Brain): a human-readable record of what the run did, what it decided,
 * what went wrong, and what to follow up on.
 */

import type { Workflow } from "../schema/workflow.ts";
import type { RunState, NodeRunState } from "../schema/run.ts";
import type { WorkflowRetrospective } from "./MemoryProvider.ts";

/** Optional run timing (epoch seconds), persisted in runs.db, not on RunState. */
export interface RetrospectiveMeta {
  started_at?: number;
  finished_at?: number;
}

/** Node label for the timeline: the spec title when set, else the node id. */
function label(workflow: Workflow, nodeId: string): string {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  const title = node && "title" in node ? node.title : undefined;
  return title ? `${title} (${nodeId})` : nodeId;
}

/** Nodes that actually ran this run, ordered by completion `seq`. */
function timeline(run: RunState): NodeRunState[] {
  return Object.values(run.nodes)
    .filter((n) => n.seq !== undefined)
    .toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function isoOrNull(epochSeconds: number | undefined): string | null {
  return epochSeconds === undefined ? null : new Date(epochSeconds * 1000).toISOString();
}

function outcomeMark(node: NodeRunState): string {
  if (node.review_decision !== undefined) return node.review_decision;
  return node.outcome ?? node.status;
}

export function buildRetrospective(
  workflow: Workflow,
  run: RunState,
  meta: RetrospectiveMeta = {},
): WorkflowRetrospective {
  const ran = timeline(run);
  const decisions = ran.filter((n) => n.review_decision !== undefined);
  const problems = ran.filter((n) => n.outcome === "failure");

  const lines: string[] = [];
  lines.push(`# ${workflow.name}: run ${run.run_id}`);
  lines.push("");
  lines.push(`- **Workflow**: ${workflow.name} (${workflow.id})`);
  lines.push(`- **Project**: ${run.project_id ?? "global"}`);
  lines.push(`- **Result**: ${run.status}`);
  const started = isoOrNull(meta.started_at);
  const finished = isoOrNull(meta.finished_at);
  if (started) lines.push(`- **Started**: ${started}`);
  if (finished) lines.push(`- **Finished**: ${finished}`);

  lines.push("", "## What happened");
  if (ran.length === 0) {
    lines.push("No nodes ran.");
  } else {
    for (const node of ran) {
      lines.push(`- ${label(workflow, node.node_id)} — ${outcomeMark(node)}`);
    }
  }

  lines.push("", "## Decisions");
  if (decisions.length === 0) {
    lines.push("None.");
  } else {
    for (const node of decisions) {
      lines.push(`- ${label(workflow, node.node_id)}: ${node.review_decision}`);
    }
  }

  lines.push("", "## Problems");
  if (problems.length === 0) {
    lines.push("None.");
  } else {
    for (const node of problems) {
      const detail = node.error ?? node.output ?? "(no detail)";
      lines.push(`- ${node.node_id}: ${detail}`);
    }
  }

  lines.push("", "## Useful signals");
  const signals = ran.filter((n) => n.output && n.outcome === "success");
  if (signals.length === 0) {
    lines.push("None.");
  } else {
    for (const node of signals) {
      lines.push(`- ${node.node_id}: ${firstLine(node.output as string)}`);
    }
  }

  lines.push("", "## Follow-up");
  if (problems.length > 0) {
    lines.push(`Investigate the failing node(s): ${problems.map((n) => n.node_id).join(", ")}.`);
  } else {
    lines.push("None.");
  }

  return { title: `${workflow.name}: run ${run.run_id}`, markdown: `${lines.join("\n")}\n` };
}

/** First line of a multi-line output, trimmed, for a compact signal entry. */
function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
