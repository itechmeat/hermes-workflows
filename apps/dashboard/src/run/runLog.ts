// A short, curated, user-facing history of a run — derived from the run
// lifecycle state the inspector already polls, NOT the raw engine/server trace.
// Deterministic and timestamp-free here; the panel stamps each event with the
// time it was first observed and never re-stamps it. Internal/server signals
// (heartbeats, dispatcher claims, lock renewals, subscription bookkeeping,
// auto-retries) are not part of run state, so they cannot leak in.
import type { RunState, NodeRunState } from "../api/types";

export interface RunLogEvent {
  /** Stable identity so an event is logged (and stamped) exactly once. */
  key: string;
  label: string;
}

/** One logged event with the epoch-ms time it was first observed. */
export interface LoggedRunEvent extends RunLogEvent {
  at: number;
}

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);

function nodeLabel(node: NodeRunState): string {
  return node.node_id;
}

/** The curated events implied by a run's CURRENT state, in narrative order:
 *  start, then each milestone by completion order, a waiting gate, and the
 *  terminal outcome. */
export function deriveRunLogEvents(run: RunState): RunLogEvent[] {
  const events: RunLogEvent[] = [
    {
      key: "run:started",
      label: run.input ? `Run started with input: ${run.input}` : "Run started",
    },
  ];

  const milestones = Object.values(run.nodes)
    .filter((n) => n.review_decision !== undefined || n.outcome !== undefined)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const n of milestones) {
    if (n.review_decision !== undefined) {
      events.push({
        key: `gate:${n.node_id}:${n.review_decision}`,
        label: `Gate "${nodeLabel(n)}" resolved: ${n.review_decision}`,
      });
    } else if (n.outcome !== undefined) {
      events.push({
        key: `node:${n.node_id}:${n.outcome}`,
        label: `${nodeLabel(n)} ${n.outcome === "failure" ? "failed" : "completed"}`,
      });
    }
  }

  for (const n of Object.values(run.nodes)) {
    if (n.status === "waiting_for_review" && n.review_decision === undefined) {
      events.push({
        key: `gate:${n.node_id}:waiting`,
        label: `Waiting for review at "${nodeLabel(n)}"`,
      });
    }
  }

  if (TERMINAL_RUN.has(run.status)) {
    events.push({ key: `run:${run.status}`, label: `Run ${run.status}` });
  }
  return events;
}

/** Merge freshly-derived events into the existing log: append any whose key is
 *  not already present, stamped with `now`. Pure (time is passed in) so it is
 *  testable; existing entries keep their original timestamp and order. */
export function mergeRunLog(
  prev: readonly LoggedRunEvent[],
  events: readonly RunLogEvent[],
  now: number,
): LoggedRunEvent[] {
  const seen = new Set(prev.map((e) => e.key));
  const added = events.filter((e) => !seen.has(e.key)).map((e) => ({ ...e, at: now }));
  return added.length === 0 ? (prev as LoggedRunEvent[]) : [...prev, ...added];
}
