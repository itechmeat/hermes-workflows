import type { NodeStatus, RunStatus } from "../schema/run.ts";

export const ACTIVE_RUN_STATUSES = [
  "created",
  "running",
  "waiting",
] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const ACTIVE_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  "running",
  "scheduled",
  "waiting_for_review",
]);
