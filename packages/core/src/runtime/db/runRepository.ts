/**
 * Typed persistence for workflow runs and node runs. Thin: it stores and
 * reconstructs RunState with no orchestration logic. The bridge loads a run,
 * calls `advance`, applies updates, and saves. Cron schedules are owned by
 * Hermes cron, not this repository.
 */

import type { Database } from "bun:sqlite";

import type { RunState, RunStatus, NodeRunState, NodeTelemetry } from "../../schema/run.ts";
import type { ParamValue } from "../../templates/params.ts";
import { ACTIVE_NODE_STATUSES, ACTIVE_RUN_STATUSES } from "../status.ts";

/** The active statuses as a quoted SQL `IN (...)` list. Safe to interpolate:
 * the values are compile-time constants from status.ts, never user input. */
const ACTIVE_STATUS_LITERALS = ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

/** Thrown by {@link RunRepository.createRun} when the workflow already has an
 * active run. Single-flight invariant: at most one run per workflow may be in
 * an active status at a time. The class name travels to the Python bridge as
 * `CoreBridgeError.kind` and maps to HTTP 409 there. */
export class ActiveRunExistsError extends Error {
  override name = "ActiveRunExistsError";
}

/** The active run blocking a new create, as the guard and the editor-attach
 * lookup see it. */
export interface ActiveRunRef {
  run_id: string;
  status: RunStatus;
  started_at?: number;
}

/** Extra run-level fields persisted alongside the reconstructable RunState. */
export interface RunMeta {
  input?: unknown;
  started_at?: number;
  finished_at?: number;
  error?: string;
}

/**
 * Flat, list-oriented projection of a run for the dashboard Runs page: the
 * run-level fields plus persisted timing meta and a derived `current_node`.
 * Distinct from {@link RunState} (which carries full per-node detail for the
 * inspector); a summary is cheap to list many of.
 */
export interface RunSummary {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  project_id?: string;
  current_node?: string;
  started_at?: number;
  finished_at?: number;
  error?: string;
  /** Sum of per-node telemetry total_tokens; absent when no node has any. */
  total_tokens?: number;
}

/** The most recent run for one workflow, for the Templates page run columns. */
export interface LatestRun {
  run_id: string;
  status: RunStatus;
  started_at?: number;
  finished_at?: number;
}

interface NodeSeq {
  node_id: string;
  seq: number;
}

/**
 * Whether `cand` should replace `best` as the chosen node: higher `seq` wins,
 * and ties (e.g. parallel nodes not yet sequenced) break on the lower `node_id`
 * so the result is deterministic across calls regardless of SQLite row order.
 */
function nodeWins(cand: NodeSeq, best: NodeSeq | undefined): boolean {
  return (
    best === undefined ||
    cand.seq > best.seq ||
    (cand.seq === best.seq && cand.node_id < best.node_id)
  );
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number | null;
  workflow_path: string | null;
  status: string;
  project_id: string | null;
  input_json: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  origin: string | null;
  notified: string | null;
  params_json: string | null;
}

interface NodeRow {
  node_id: string;
  node_type: string | null;
  status: string;
  hermes_task_id: string | null;
  driven_task_ids: string | null;
  reviewed_task_ids: string | null;
  wait_started_at: string | null;
  adopt_seq_json: string | null;
  adopt_blocked_since: string | null;
  task_ids_json: string | null;
  transient_retries: string | null;
  retry_after: string | null;
  outcome: string | null;
  review_decision: string | null;
  review_note: string | null;
  seq: number | null;
  output_json: string | null;
  error: string | null;
  telemetry_json: string | null;
}

export class RunRepository {
  constructor(private readonly db: Database) {}

  /**
   * The workflow's active run (status `created`/`running`/`waiting`), if any.
   * Pre-guard databases can hold several; the newest `started_at` wins, ties
   * broken on the higher `run_id` — the same convention as
   * {@link latestRunByWorkflow}, so the editor attach is deterministic.
   * `excludeRunId` lets retry ignore the run it is reviving.
   */
  findActiveRun(workflowId: string, excludeRunId?: string): ActiveRunRef | undefined {
    const row = this.db
      .query(
        `SELECT id, status, started_at FROM workflow_runs
         WHERE workflow_id = $wf
           AND status IN (${ACTIVE_STATUS_LITERALS})
           AND ($exclude IS NULL OR id != $exclude)
         ORDER BY COALESCE(started_at, -1) DESC, id DESC
         LIMIT 1`,
      )
      .get({
        $wf: workflowId,
        $exclude: excludeRunId ?? null,
      }) as Pick<RunRow, "id" | "status" | "started_at"> | null;
    if (!row) return undefined;
    const ref: ActiveRunRef = { run_id: row.id, status: row.status as RunStatus };
    if (row.started_at !== null) ref.started_at = row.started_at;
    return ref;
  }

  /** Throw {@link ActiveRunExistsError} when the workflow has an active run
   * other than `excludeRunId`. */
  private assertNoActiveSibling(workflowId: string, excludeRunId?: string): void {
    const active = this.findActiveRun(workflowId, excludeRunId);
    if (active !== undefined) {
      throw new ActiveRunExistsError(
        `workflow '${workflowId}' already has an active run ` +
          `'${active.run_id}' (status ${active.status}); ` +
          `cancel it or wait for it to finish before starting another`,
      );
    }
  }

  /** Single-flight write: run `write` after {@link assertNoActiveSibling},
   * both inside one IMMEDIATE transaction — the write lock is taken before
   * the check, so two concurrent writers serialize and the loser sees the
   * winner's row and throws. */
  private guardedWrite(workflowId: string, excludeRunId: string | undefined, write: () => void) {
    const guarded = this.db.transaction(() => {
      this.assertNoActiveSibling(workflowId, excludeRunId);
      write();
    });
    guarded.immediate();
  }

  /** Insert a brand-new run, enforcing single-flight: at most one active run
   * per workflow ({@link ActiveRunExistsError} otherwise). */
  createRun(run: RunState, meta: RunMeta = {}): void {
    this.guardedWrite(run.workflow_id, undefined, () => this.saveRun(run, meta));
  }

  /** Save a revived run (retry): the same single-flight guard as
   * {@link createRun}, except the run being revived is excluded — it becoming
   * active again is the point; a *different* active sibling blocks it. */
  reviveRun(run: RunState, meta: RunMeta = {}): void {
    this.guardedWrite(run.workflow_id, run.run_id, () => this.saveRun(run, meta));
  }

  /** Insert or update a run and all of its node rows in one transaction. */
  saveRun(run: RunState, meta: RunMeta = {}): void {
    const save = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO workflow_runs
             (id, workflow_id, workflow_version, workflow_path, status, project_id, input_json, started_at, finished_at, error, origin, notified, params_json)
           VALUES ($id, $wf, $ver, $path, $status, $project, $input, $started, $finished, $error, $origin, $notified, $params)
           ON CONFLICT(id) DO UPDATE SET
             workflow_path = excluded.workflow_path,
             status = excluded.status,
             project_id = excluded.project_id,
             input_json = excluded.input_json,
             -- started_at is stamped once (at run-create) and preserved across
             -- meta-less tick saves; finished_at follows the live status, set
             -- when terminal and cleared on retry.
             started_at = COALESCE(workflow_runs.started_at, excluded.started_at),
             finished_at = excluded.finished_at,
             error = excluded.error,
             -- origin, notified, and params live on the RunState, which every
             -- save carries in full, so overwriting with the incoming value is
             -- correct.
             origin = excluded.origin,
             notified = excluded.notified,
             params_json = excluded.params_json`,
        )
        .run({
          $id: run.run_id,
          $wf: run.workflow_id,
          $ver: run.workflow_version,
          $path: run.workflow_path ?? null,
          $status: run.status,
          $project: run.project_id ?? null,
          $input:
            run.input !== undefined
              ? JSON.stringify(run.input)
              : meta.input === undefined
                ? null
                : JSON.stringify(meta.input),
          $started: meta.started_at ?? null,
          $finished: meta.finished_at ?? null,
          $error: meta.error ?? null,
          $origin: run.origin ?? null,
          $notified: run.notified && run.notified.length > 0 ? JSON.stringify(run.notified) : null,
          $params:
            run.params && Object.keys(run.params).length > 0 ? JSON.stringify(run.params) : null,
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
           (id, run_id, node_id, node_type, status, hermes_task_id, driven_task_ids, reviewed_task_ids, wait_started_at, adopt_seq_json, adopt_blocked_since, task_ids_json, transient_retries, retry_after, outcome, review_decision, review_note, seq, output_json, error, telemetry_json)
         VALUES ($id, $run, $node, $type, $status, $task, $driven, $reviewed, $waitStarted, $adoptSeq, $adoptBlocked, $taskIds, $transientRetries, $retryAfter, $outcome, $review, $reviewNote, $seq, $output, $error, $telemetry)
         ON CONFLICT(id) DO UPDATE SET
           node_type = excluded.node_type,
           status = excluded.status,
           hermes_task_id = excluded.hermes_task_id,
           driven_task_ids = excluded.driven_task_ids,
           reviewed_task_ids = excluded.reviewed_task_ids,
           wait_started_at = excluded.wait_started_at,
           adopt_seq_json = excluded.adopt_seq_json,
           adopt_blocked_since = excluded.adopt_blocked_since,
           task_ids_json = excluded.task_ids_json,
           transient_retries = excluded.transient_retries,
           retry_after = excluded.retry_after,
           outcome = excluded.outcome,
           review_decision = excluded.review_decision,
           review_note = excluded.review_note,
           seq = excluded.seq,
           output_json = excluded.output_json,
           error = excluded.error,
           telemetry_json = excluded.telemetry_json`,
      )
      .run({
        $id: `${runId}:${node.node_id}`,
        $run: runId,
        $node: node.node_id,
        $type: node.node_type ?? null,
        $status: node.status,
        $task: node.hermes_task_id ?? null,
        $driven:
          node.driven_task_ids && node.driven_task_ids.length > 0
            ? JSON.stringify(node.driven_task_ids)
            : null,
        $reviewed:
          node.reviewed_task_ids && node.reviewed_task_ids.length > 0
            ? JSON.stringify(node.reviewed_task_ids)
            : null,
        $waitStarted: node.wait_started_at === undefined ? null : String(node.wait_started_at),
        $adoptSeq: node.adopt_seq === undefined ? null : JSON.stringify(node.adopt_seq),
        $adoptBlocked:
          node.adopt_blocked_since === undefined ? null : String(node.adopt_blocked_since),
        $taskIds: node.task_ids && node.task_ids.length > 0 ? JSON.stringify(node.task_ids) : null,
        $transientRetries:
          node.transient_retries === undefined ? null : String(node.transient_retries),
        $retryAfter: node.retry_after === undefined ? null : String(node.retry_after),
        $outcome: node.outcome ?? null,
        $review: node.review_decision ?? null,
        $reviewNote: node.review_note ?? null,
        $seq: node.seq ?? null,
        $output: node.output ?? null,
        $error: node.error ?? null,
        $telemetry: node.telemetry === undefined ? null : JSON.stringify(node.telemetry),
      });
  }

  loadRun(runId: string): RunState | null {
    const row = this.db
      .query(`SELECT * FROM workflow_runs WHERE id = $id`)
      .get({ $id: runId }) as RunRow | null;
    if (!row) return null;

    const nodeRows = this.db
      .query(`SELECT * FROM workflow_node_runs WHERE run_id = $id`)
      .all({ $id: runId }) as NodeRow[];

    const nodes: Record<string, NodeRunState> = {};
    for (const n of nodeRows) {
      const node: NodeRunState = {
        node_id: n.node_id,
        status: n.status as NodeRunState["status"],
      };
      if (n.node_type !== null) node.node_type = n.node_type;
      if (n.hermes_task_id !== null) node.hermes_task_id = n.hermes_task_id;
      if (n.driven_task_ids !== null) {
        node.driven_task_ids = JSON.parse(n.driven_task_ids) as string[];
      }
      if (n.reviewed_task_ids !== null) {
        node.reviewed_task_ids = JSON.parse(n.reviewed_task_ids) as string[];
      }
      if (n.wait_started_at !== null) node.wait_started_at = Number(n.wait_started_at);
      if (n.adopt_seq_json !== null) {
        node.adopt_seq = JSON.parse(n.adopt_seq_json) as NodeRunState["adopt_seq"];
      }
      if (n.adopt_blocked_since !== null) node.adopt_blocked_since = Number(n.adopt_blocked_since);
      if (n.task_ids_json !== null) {
        node.task_ids = JSON.parse(n.task_ids_json) as string[];
      }
      if (n.transient_retries !== null) node.transient_retries = Number(n.transient_retries);
      if (n.retry_after !== null) node.retry_after = Number(n.retry_after);
      if (n.outcome !== null) node.outcome = n.outcome as NodeRunState["outcome"];
      if (n.review_decision !== null)
        node.review_decision = n.review_decision as NodeRunState["review_decision"];
      if (n.review_note !== null) node.review_note = n.review_note;
      if (n.seq !== null) node.seq = n.seq;
      if (n.output_json !== null) node.output = n.output_json;
      if (n.error !== null) node.error = n.error;
      if (n.telemetry_json !== null) {
        node.telemetry = JSON.parse(n.telemetry_json) as NodeTelemetry;
      }
      nodes[n.node_id] = node;
    }

    const run: RunState = {
      run_id: row.id,
      workflow_id: row.workflow_id,
      workflow_version: row.workflow_version ?? 0,
      status: row.status as RunStatus,
      nodes,
    };
    if (row.workflow_path !== null) run.workflow_path = row.workflow_path;
    if (row.project_id !== null) run.project_id = row.project_id;
    if (row.input_json !== null) {
      const parsed = JSON.parse(row.input_json) as unknown;
      if (typeof parsed === "string") run.input = parsed;
    }
    if (row.origin !== null) run.origin = row.origin;
    if (row.notified !== null) {
      const parsed = JSON.parse(row.notified) as string[];
      if (parsed.length > 0) run.notified = parsed;
    }
    if (row.params_json !== null) {
      const parsed = JSON.parse(row.params_json) as Record<string, ParamValue>;
      if (parsed && Object.keys(parsed).length > 0) run.params = parsed;
    }
    return run;
  }

  listActiveRuns(): RunState[] {
    const ids = this.db
      .query(`SELECT id FROM workflow_runs WHERE status IN (${ACTIVE_STATUS_LITERALS})`)
      .all() as { id: string }[];
    return this.hydrate(ids);
  }

  listAllRuns(): RunState[] {
    const ids = this.db.query(`SELECT id FROM workflow_runs`).all() as {
      id: string;
    }[];
    return this.hydrate(ids);
  }

  private hydrate(ids: { id: string }[]): RunState[] {
    return ids.map((r) => this.loadRun(r.id)).filter((r): r is RunState => r !== null);
  }

  /**
   * List runs as flat summaries for the dashboard Runs page, newest
   * `started_at` first (ties on the higher `run_id`, never-started runs last —
   * the {@link findActiveRun} convention). `activeOnly` restricts to in-flight
   * runs (same filter as {@link listActiveRuns}); `workflowId` to one
   * workflow's runs (the editor-attach lookup). Each summary carries the
   * persisted timing meta and a derived `current_node`.
   */
  listRunSummaries(activeOnly: boolean, workflowId?: string): RunSummary[] {
    const where: string[] = [];
    if (activeOnly) where.push(`status IN (${ACTIVE_STATUS_LITERALS})`);
    if (workflowId !== undefined) where.push("workflow_id = $wf");
    const sql =
      `SELECT * FROM workflow_runs` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY COALESCE(started_at, -1) DESC, id DESC`;
    const query = this.db.query(sql);
    const rows = (
      workflowId !== undefined ? query.all({ $wf: workflowId }) : query.all()
    ) as RunRow[];
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * Map each workflow id to its most recent run. "Most recent" is the highest
   * `started_at` (a not-yet-started run sorts as -1, below any stamped run),
   * with ties broken on the higher `run_id` so the result is stable regardless
   * of SQLite row order. Workflows with no run are absent from the map.
   */
  latestRunByWorkflow(): Record<string, LatestRun> {
    const rows = this.db
      .query(`SELECT id, workflow_id, status, started_at, finished_at FROM workflow_runs`)
      .all() as Pick<RunRow, "id" | "workflow_id" | "status" | "started_at" | "finished_at">[];
    const latest: Record<string, LatestRun> = {};
    const sortKey: Record<string, number> = {};
    for (const row of rows) {
      const started = row.started_at ?? -1;
      const prev = sortKey[row.workflow_id];
      const prevRun = latest[row.workflow_id];
      const wins =
        prev === undefined ||
        started > prev ||
        (started === prev && prevRun !== undefined && row.id > prevRun.run_id);
      if (!wins) continue;
      sortKey[row.workflow_id] = started;
      const run: LatestRun = {
        run_id: row.id,
        status: row.status as RunStatus,
      };
      if (row.started_at !== null) run.started_at = row.started_at;
      if (row.finished_at !== null) run.finished_at = row.finished_at;
      latest[row.workflow_id] = run;
    }
    return latest;
  }

  private toSummary(row: RunRow): RunSummary {
    const summary: RunSummary = {
      run_id: row.id,
      workflow_id: row.workflow_id,
      workflow_version: row.workflow_version ?? 0,
      status: row.status as RunStatus,
    };
    if (row.project_id !== null) summary.project_id = row.project_id;
    if (row.started_at !== null) summary.started_at = row.started_at;
    if (row.finished_at !== null) summary.finished_at = row.finished_at;
    if (row.error !== null) summary.error = row.error;
    const current = this.currentNode(row.id);
    if (current !== undefined) summary.current_node = current;
    const tokens = this.totalTokens(row.id);
    if (tokens !== undefined) summary.total_tokens = tokens;
    return summary;
  }

  /**
   * Sum of `total_tokens` across the run's node telemetry, or undefined when
   * no node carries a token count (so token-less runs show no zero).
   */
  private totalTokens(runId: string): number | undefined {
    const rows = this.db
      .query(
        `SELECT telemetry_json FROM workflow_node_runs
         WHERE run_id = $id AND telemetry_json IS NOT NULL`,
      )
      .all({ $id: runId }) as { telemetry_json: string }[];
    let sum: number | undefined;
    for (const row of rows) {
      const telemetry = JSON.parse(row.telemetry_json) as NodeTelemetry;
      if (typeof telemetry.total_tokens === "number") {
        sum = (sum ?? 0) + telemetry.total_tokens;
      }
    }
    return sum;
  }

  /**
   * The node a run is "on": the active node (running / scheduled / awaiting
   * review) if any, else the most recently settled node by `seq`. Returns
   * undefined when no node has advanced yet.
   */
  private currentNode(runId: string): string | undefined {
    const nodes = this.db
      .query(`SELECT node_id, status, seq FROM workflow_node_runs WHERE run_id = $id`)
      .all({ $id: runId }) as {
      node_id: string;
      status: string;
      seq: number | null;
    }[];
    let active: NodeSeq | undefined;
    let latest: NodeSeq | undefined;
    for (const n of nodes) {
      const candidate: NodeSeq = { node_id: n.node_id, seq: n.seq ?? -1 };
      if (
        ACTIVE_NODE_STATUSES.has(n.status as NodeRunState["status"]) &&
        nodeWins(candidate, active)
      ) {
        active = candidate;
      }
      if (n.seq !== null && nodeWins(candidate, latest)) {
        latest = candidate;
      }
    }
    return (active ?? latest)?.node_id;
  }
}
