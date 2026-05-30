/**
 * Typed persistence for workflow runs and node runs. Thin: it stores and
 * reconstructs RunState with no orchestration logic. The bridge loads a run,
 * calls `advance`, applies updates, and saves. Cron schedules are owned by
 * Hermes cron, not this repository.
 */

import type { Database } from "bun:sqlite";

import type { RunState, RunStatus, NodeRunState } from "../../schema/run.ts";

/** Extra run-level fields persisted alongside the reconstructable RunState. */
export interface RunMeta {
  input?: unknown;
  started_at?: number;
  finished_at?: number;
  error?: string;
}

const ACTIVE_STATUSES: readonly RunStatus[] = ["created", "running", "waiting"];

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number | null;
  status: string;
  project_id: string | null;
  input_json: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

interface NodeRow {
  node_id: string;
  status: string;
  hermes_task_id: string | null;
  outcome: string | null;
  review_decision: string | null;
  seq: number | null;
  output_json: string | null;
  error: string | null;
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  /** Insert or update a run and all of its node rows in one transaction. */
  saveRun(run: RunState, meta: RunMeta = {}): void {
    const save = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO workflow_runs
             (id, workflow_id, workflow_version, status, project_id, input_json, started_at, finished_at, error)
           VALUES ($id, $wf, $ver, $status, $project, $input, $started, $finished, $error)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             project_id = excluded.project_id,
             input_json = excluded.input_json,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             error = excluded.error`,
        )
        .run({
          $id: run.run_id,
          $wf: run.workflow_id,
          $ver: run.workflow_version,
          $status: run.status,
          $project: run.project_id ?? null,
          $input: meta.input === undefined ? null : JSON.stringify(meta.input),
          $started: meta.started_at ?? null,
          $finished: meta.finished_at ?? null,
          $error: meta.error ?? null,
        });

      for (const node of Object.values(run.nodes)) {
        this.upsertNode(run.run_id, node);
      }
    });
    save();
  }

  private upsertNode(runId: string, node: NodeRunState): void {
    this.db
      .query(
        `INSERT INTO workflow_node_runs
           (id, run_id, node_id, status, hermes_task_id, outcome, review_decision, seq, output_json, error)
         VALUES ($id, $run, $node, $status, $task, $outcome, $review, $seq, $output, $error)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           hermes_task_id = excluded.hermes_task_id,
           outcome = excluded.outcome,
           review_decision = excluded.review_decision,
           seq = excluded.seq,
           output_json = excluded.output_json,
           error = excluded.error`,
      )
      .run({
        $id: `${runId}:${node.node_id}`,
        $run: runId,
        $node: node.node_id,
        $status: node.status,
        $task: node.hermes_task_id ?? null,
        $outcome: node.outcome ?? null,
        $review: node.review_decision ?? null,
        $seq: node.seq ?? null,
        $output: node.output ?? null,
        $error: node.error ?? null,
      });
  }

  loadRun(runId: string): RunState | null {
    const row = this.db.query(`SELECT * FROM workflow_runs WHERE id = $id`).get({ $id: runId }) as
      | RunRow
      | null;
    if (!row) return null;

    const nodeRows = this.db
      .query(`SELECT * FROM workflow_node_runs WHERE run_id = $id`)
      .all({ $id: runId }) as NodeRow[];

    const nodes: Record<string, NodeRunState> = {};
    for (const n of nodeRows) {
      const node: NodeRunState = { node_id: n.node_id, status: n.status as NodeRunState["status"] };
      if (n.hermes_task_id !== null) node.hermes_task_id = n.hermes_task_id;
      if (n.outcome !== null) node.outcome = n.outcome as NodeRunState["outcome"];
      if (n.review_decision !== null) node.review_decision = n.review_decision as NodeRunState["review_decision"];
      if (n.seq !== null) node.seq = n.seq;
      if (n.output_json !== null) node.output = n.output_json;
      if (n.error !== null) node.error = n.error;
      nodes[n.node_id] = node;
    }

    const run: RunState = {
      run_id: row.id,
      workflow_id: row.workflow_id,
      workflow_version: row.workflow_version ?? 0,
      status: row.status as RunStatus,
      nodes,
    };
    if (row.project_id !== null) run.project_id = row.project_id;
    return run;
  }

  listActiveRuns(): RunState[] {
    const ids = this.db
      .query(
        `SELECT id FROM workflow_runs WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`,
      )
      .all(...ACTIVE_STATUSES) as { id: string }[];
    return this.hydrate(ids);
  }

  listAllRuns(): RunState[] {
    const ids = this.db.query(`SELECT id FROM workflow_runs`).all() as { id: string }[];
    return this.hydrate(ids);
  }

  private hydrate(ids: { id: string }[]): RunState[] {
    return ids.map((r) => this.loadRun(r.id)).filter((r): r is RunState => r !== null);
  }
}
