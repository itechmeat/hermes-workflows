import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openRunsDatabase, RunRepository, createRunState, fromObject } from "../src/index.ts";
import type { Database } from "bun:sqlite";

const workflow = fromObject({
  id: "wf",
  name: "WF",
  version: 2,
  scope: { type: "global" },
  trigger: { type: "manual" },
  defaults: { profile: "p" },
  nodes: [
    { id: "a", type: "agent_task", prompt: "x" },
    { id: "done", type: "finish" },
  ],
  edges: [{ from: "a", to: "done" }],
}).workflow;

let dir: string;
let db: Database;
let repo: RunRepository;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hw-db-"));
  db = openRunsDatabase(join(dir, "runs.db"));
  repo = new RunRepository(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("openRunsDatabase", () => {
  test("enables WAL and creates the schema (idempotent)", () => {
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["workflow_node_runs", "workflow_runs"]);
  });
});

describe("RunRepository — runs", () => {
  test("round-trips a run with node state", () => {
    const run = createRunState(workflow, "run-1", "proj");
    run.status = "running";
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "success",
      seq: 1,
      hermes_task_id: "t_123",
      output: "did the thing",
    };
    repo.saveRun(run, { input: { feature: "x" }, started_at: 100 });

    const loaded = repo.loadRun("run-1");
    expect(loaded?.status).toBe("running");
    expect(loaded?.workflow_version).toBe(2);
    expect(loaded?.project_id).toBe("proj");
    expect(loaded?.nodes["a"]).toEqual({
      node_id: "a",
      status: "completed",
      outcome: "success",
      seq: 1,
      hermes_task_id: "t_123",
      output: "did the thing",
    });
    expect(loaded?.nodes["done"]?.status).toBe("pending");
  });

  test("round-trips a run origin and notification markers", () => {
    const run = createRunState(workflow, "run-origin", undefined, "telegram:1:2");
    run.status = "running";
    run.notified = ["completed", "mem:run_completed"];
    repo.saveRun(run);

    const loaded = repo.loadRun("run-origin");
    expect(loaded?.origin).toBe("telegram:1:2");
    expect(loaded?.notified).toEqual(["completed", "mem:run_completed"]);

    // A run without an origin loads with origin absent and no markers.
    const bare = createRunState(workflow, "run-bare");
    repo.saveRun(bare);
    const bareLoaded = repo.loadRun("run-bare");
    expect(bareLoaded?.origin).toBeUndefined();
    expect(bareLoaded?.notified).toBeUndefined();

    // A marker set on one save survives a reload (idempotency store).
    const reloaded = repo.loadRun("run-origin") as typeof run;
    reloaded.notified = [...(reloaded.notified ?? []), "failed"];
    repo.saveRun(reloaded);
    expect(repo.loadRun("run-origin")?.notified).toEqual([
      "completed",
      "mem:run_completed",
      "failed",
    ]);
  });

  test("upserts on save and returns null for an unknown run", () => {
    const run = createRunState(workflow, "run-2");
    repo.saveRun(run);
    run.status = "completed";
    repo.saveRun(run);
    expect(repo.loadRun("run-2")?.status).toBe("completed");
    expect(repo.loadRun("ghost")).toBeNull();
  });

  test("lists only active runs", () => {
    const active = createRunState(workflow, "run-active");
    active.status = "waiting";
    repo.saveRun(active);
    const finished = createRunState(workflow, "run-finished");
    finished.status = "completed";
    repo.saveRun(finished);

    const ids = repo.listActiveRuns().map((r) => r.run_id);
    expect(ids).toContain("run-active");
    expect(ids).not.toContain("run-finished");
  });
});

describe("RunRepository — run summaries", () => {
  test("lists summaries with meta and the derived current node", () => {
    const running = createRunState(workflow, "sum-running", "projX");
    running.status = "running";
    running.nodes["a"] = { node_id: "a", status: "running", seq: 1 };
    repo.saveRun(running, { started_at: 1000 });

    const finished = createRunState(workflow, "sum-finished");
    finished.status = "completed";
    finished.nodes["a"] = { node_id: "a", status: "completed", outcome: "success", seq: 1 };
    finished.nodes["done"] = { node_id: "done", status: "completed", seq: 2 };
    repo.saveRun(finished, { started_at: 2000, finished_at: 2500 });

    const all = repo.listRunSummaries(false);
    const s1 = all.find((s) => s.run_id === "sum-running");
    expect(s1?.workflow_id).toBe("wf");
    expect(s1?.workflow_version).toBe(2);
    expect(s1?.project_id).toBe("projX");
    expect(s1?.status).toBe("running");
    expect(s1?.current_node).toBe("a"); // the active node
    expect(s1?.started_at).toBe(1000);
    expect(s1?.finished_at).toBeUndefined();

    const s2 = all.find((s) => s.run_id === "sum-finished");
    expect(s2?.current_node).toBe("done"); // highest-seq settled node
    expect(s2?.finished_at).toBe(2500);

    const active = repo.listRunSummaries(true).map((s) => s.run_id);
    expect(active).toContain("sum-running");
    expect(active).not.toContain("sum-finished");
  });

  test("preserves started_at across meta-less saves and tracks finished_at", () => {
    const run = createRunState(workflow, "sum-timing");
    run.status = "running";
    repo.saveRun(run, { started_at: 5000 });

    // A later tick save without meta must not wipe started_at, and leaves the
    // still-running run with no finished_at.
    repo.saveRun(run);
    let s = repo.listRunSummaries(false).find((r) => r.run_id === "sum-timing");
    expect(s?.started_at).toBe(5000);
    expect(s?.finished_at).toBeUndefined();

    // Terminal save stamps finished_at; started_at is still preserved.
    run.status = "completed";
    repo.saveRun(run, { finished_at: 5200 });
    s = repo.listRunSummaries(false).find((r) => r.run_id === "sum-timing");
    expect(s?.started_at).toBe(5000);
    expect(s?.finished_at).toBe(5200);

    // Back in flight (retry) clears finished_at without losing started_at.
    run.status = "created";
    repo.saveRun(run);
    s = repo.listRunSummaries(false).find((r) => r.run_id === "sum-timing");
    expect(s?.started_at).toBe(5000);
    expect(s?.finished_at).toBeUndefined();
  });

  test("breaks current-node ties on node_id deterministically", () => {
    const run = createRunState(workflow, "sum-tie");
    run.status = "running";
    // two active nodes, same (default) seq -> lower node_id wins, stably.
    run.nodes["a"] = { node_id: "a", status: "running" };
    run.nodes["done"] = { node_id: "done", status: "scheduled" };
    repo.saveRun(run);
    const s = repo.listRunSummaries(false).find((r) => r.run_id === "sum-tie");
    expect(s?.current_node).toBe("a");
  });
});

describe("RunRepository — latest run by workflow", () => {
  let ldir: string;
  let ldb: Database;
  let lrepo: RunRepository;
  const wfB = fromObject({ ...workflow, id: "wfB" }).workflow;

  beforeAll(async () => {
    ldir = await mkdtemp(join(tmpdir(), "hw-latest-"));
    ldb = openRunsDatabase(join(ldir, "runs.db"));
    lrepo = new RunRepository(ldb);
  });

  afterAll(async () => {
    ldb.close();
    await rm(ldir, { recursive: true, force: true });
  });

  test("maps each workflow to its most recent run by started_at", () => {
    const older = createRunState(workflow, "wf-older");
    older.status = "completed";
    lrepo.saveRun(older, { started_at: 100, finished_at: 150 });

    const newer = createRunState(workflow, "wf-newer");
    newer.status = "running";
    lrepo.saveRun(newer, { started_at: 200 });

    const otherWf = createRunState(wfB, "wfB-run");
    otherWf.status = "completed";
    lrepo.saveRun(otherWf, { started_at: 50, finished_at: 80 });

    const latest = lrepo.latestRunByWorkflow();
    expect(latest["wf"]).toEqual({
      run_id: "wf-newer",
      status: "running",
      started_at: 200,
    });
    expect(latest["wfB"]).toEqual({
      run_id: "wfB-run",
      status: "completed",
      started_at: 50,
      finished_at: 80,
    });
  });

  test("breaks ties on run_id and omits workflows with no run", () => {
    const a = createRunState(workflow, "tie-a");
    a.status = "completed";
    lrepo.saveRun(a, { started_at: 999, finished_at: 1000 });
    const b = createRunState(workflow, "tie-b");
    b.status = "completed";
    lrepo.saveRun(b, { started_at: 999, finished_at: 1000 });

    // equal started_at -> higher run_id wins ("tie-b" > "tie-a") so the result
    // is stable regardless of SQLite row order.
    expect(lrepo.latestRunByWorkflow()["wf"]?.run_id).toBe("tie-b");
    expect(lrepo.latestRunByWorkflow()["never-ran"]).toBeUndefined();
  });
});
