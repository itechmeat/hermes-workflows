import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ActiveRunExistsError,
  openRunsDatabase,
  RunRepository,
  createRunState,
  fromObject,
} from "../src/index.ts";
import type { Database } from "bun:sqlite";
import type { RunState } from "../src/index.ts";

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

  test("round-trips a run's resolved template params", () => {
    const run = createRunState(workflow, "run-params", undefined, undefined, undefined, {
      region: "eu",
      count: 3,
      flag: true,
    });
    repo.saveRun(run);
    expect(repo.loadRun("run-params")?.params).toEqual({ region: "eu", count: 3, flag: true });

    // An empty/absent param map persists as absent, not as {}.
    const bare = createRunState(workflow, "run-no-params");
    repo.saveRun(bare);
    expect(repo.loadRun("run-no-params")?.params).toBeUndefined();
  });

  test("round-trips a node's typed task_ids channel", () => {
    const run = createRunState(workflow, "run-taskids");
    run.status = "running";
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "success",
      seq: 1,
      task_ids: ["t_aaa", "t_bbb"],
    };
    repo.saveRun(run);
    expect(repo.loadRun("run-taskids")?.nodes["a"]?.task_ids).toEqual(["t_aaa", "t_bbb"]);

    // An empty/absent list persists as absent, not as [].
    const bare = createRunState(workflow, "run-no-taskids");
    bare.nodes["a"] = { node_id: "a", status: "completed", outcome: "success", seq: 1 };
    repo.saveRun(bare);
    expect(repo.loadRun("run-no-taskids")?.nodes["a"]?.task_ids).toBeUndefined();
  });

  test("round-trips a node's transient-retry state across ticks", () => {
    const run = createRunState(workflow, "run-retry");
    run.status = "running";
    // A node mid-backoff: retried once, awaiting the next attempt. Both fields
    // must survive the reload the tick performs each pass.
    run.nodes["a"] = {
      node_id: "a",
      status: "scheduled",
      transient_retries: 1,
      retry_after: 1700000042,
    };
    repo.saveRun(run);
    const loaded = repo.loadRun("run-retry")?.nodes["a"];
    expect(loaded?.transient_retries).toBe(1);
    expect(loaded?.retry_after).toBe(1700000042);

    // Absent on a node that never hit a transient error.
    const bare = createRunState(workflow, "run-no-retry");
    bare.nodes["a"] = { node_id: "a", status: "completed", outcome: "success", seq: 1 };
    repo.saveRun(bare);
    const bareLoaded = repo.loadRun("run-no-retry")?.nodes["a"];
    expect(bareLoaded?.transient_retries).toBeUndefined();
    expect(bareLoaded?.retry_after).toBeUndefined();
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

  test("round-trips a run-level operator input", () => {
    const run = createRunState(
      workflow,
      "run-input",
      undefined,
      undefined,
      "scope = only X; be terse",
    );
    expect(run.input).toBe("scope = only X; be terse");
    repo.saveRun(run);
    expect(repo.loadRun("run-input")?.input).toBe("scope = only X; be terse");

    // A run started without operator input loads with input absent.
    const bare = createRunState(workflow, "run-noinput");
    repo.saveRun(bare);
    expect(repo.loadRun("run-noinput")?.input).toBeUndefined();
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

describe("RunRepository — node telemetry", () => {
  test("round-trips NodeRunState.telemetry and omits it when absent", () => {
    const run = createRunState(workflow, "run-telemetry");
    run.status = "running";
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "success",
      seq: 1,
      telemetry: {
        duration_ms: 5500,
        input_tokens: 17,
        output_tokens: 8,
        total_tokens: 25,
        api_calls: 2,
        tool_calls: 3,
        error_type: "ToolError",
        error_message: "exit 1",
        approval: { state: "resolved", command: "rm -rf x", choice: "deny" },
      },
    };
    repo.saveRun(run);

    const loaded = repo.loadRun("run-telemetry");
    expect(loaded?.nodes["a"]?.telemetry).toEqual({
      duration_ms: 5500,
      input_tokens: 17,
      output_tokens: 8,
      total_tokens: 25,
      api_calls: 2,
      tool_calls: 3,
      error_type: "ToolError",
      error_message: "exit 1",
      approval: { state: "resolved", command: "rm -rf x", choice: "deny" },
    });
    expect(loaded?.nodes["done"]?.telemetry).toBeUndefined();
  });

  test("summaries sum node total_tokens into the run total", () => {
    const run = createRunState(workflow, "run-tokens");
    run.status = "completed";
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "success",
      seq: 1,
      telemetry: { total_tokens: 25 },
    };
    run.nodes["done"] = {
      node_id: "done",
      status: "completed",
      seq: 2,
      telemetry: { total_tokens: 5 },
    };
    repo.saveRun(run);

    const summary = repo.listRunSummaries(false).find((s) => s.run_id === "run-tokens");
    expect(summary?.total_tokens).toBe(30);

    // A run with no telemetry anywhere has no total at all.
    const bare = createRunState(workflow, "run-no-tokens");
    repo.saveRun(bare);
    const bareSummary = repo.listRunSummaries(false).find((s) => s.run_id === "run-no-tokens");
    expect(bareSummary?.total_tokens).toBeUndefined();
  });

  test("migrates a pre-telemetry database in place", async () => {
    const mdir = await mkdtemp(join(tmpdir(), "hw-migrate-"));
    const path = join(mdir, "runs.db");
    // A database created before the telemetry_json column existed.
    const legacy = openRunsDatabase(path);
    legacy.run("ALTER TABLE workflow_node_runs DROP COLUMN telemetry_json");
    legacy.close();

    const reopened = openRunsDatabase(path); // must ALTER it back, idempotently
    const cols = (
      reopened.query("PRAGMA table_info(workflow_node_runs)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("telemetry_json");
    const mrepo = new RunRepository(reopened);
    const run = createRunState(workflow, "migrated-run");
    run.nodes["a"] = { node_id: "a", status: "completed", telemetry: { api_calls: 1 } };
    mrepo.saveRun(run);
    expect(mrepo.loadRun("migrated-run")?.nodes["a"]?.telemetry).toEqual({ api_calls: 1 });
    reopened.close();
    await rm(mdir, { recursive: true, force: true });
  });
});

describe("active run statuses", () => {
  test("are safe to interpolate as SQL literals (no quotes or backslashes)", async () => {
    // The repository inlines ACTIVE_RUN_STATUSES into IN (...) lists; that is
    // sound only while every value stays a plain lowercase token.
    const { ACTIVE_RUN_STATUSES } = await import("../src/runtime/status.ts");
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(status).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("RunRepository — single-flight create", () => {
  let sdir: string;
  let sdb: Database;
  let srepo: RunRepository;
  const wfOther = fromObject({ ...workflow, id: "wf-other" }).workflow;

  beforeAll(async () => {
    sdir = await mkdtemp(join(tmpdir(), "hw-single-flight-"));
    sdb = openRunsDatabase(join(sdir, "runs.db"));
    srepo = new RunRepository(sdb);
  });

  afterAll(async () => {
    sdb.close();
    await rm(sdir, { recursive: true, force: true });
  });

  test("createRun inserts when the workflow has no active run", () => {
    const run = createRunState(workflow, "sf-first");
    srepo.createRun(run, { started_at: 10 });
    expect(srepo.loadRun("sf-first")?.status).toBe("created");
    expect(srepo.loadRun("sf-first")?.workflow_id).toBe("wf");
  });

  test("createRun refuses a second run while a sibling is active, per active status", () => {
    for (const status of ["created", "running", "waiting"] as const) {
      const sibling = srepo.loadRun("sf-first") as RunState;
      sibling.status = status;
      srepo.saveRun(sibling);

      const second = createRunState(workflow, `sf-second-${status}`);
      expect(() => srepo.createRun(second, { started_at: 20 })).toThrow(ActiveRunExistsError);
      // The refused run must not be persisted.
      expect(srepo.loadRun(`sf-second-${status}`)).toBeNull();
    }
  });

  test("the error names the workflow, the active run id, and its status", () => {
    const second = createRunState(workflow, "sf-named");
    let thrown: unknown;
    try {
      srepo.createRun(second, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActiveRunExistsError);
    const err = thrown as ActiveRunExistsError;
    expect(err.name).toBe("ActiveRunExistsError"); // travels to Python as `kind`
    expect(err.message).toContain("wf");
    expect(err.message).toContain("sf-first");
    expect(err.message).toContain("waiting"); // last status the loop above left
  });

  test("a different workflow is unaffected by the active sibling", () => {
    const other = createRunState(wfOther, "sf-other");
    srepo.createRun(other, { started_at: 30 });
    expect(srepo.loadRun("sf-other")?.status).toBe("created");
  });

  test("createRun succeeds again once the sibling settles", () => {
    const sibling = srepo.loadRun("sf-first") as RunState;
    sibling.status = "completed";
    srepo.saveRun(sibling, { finished_at: 50 });

    const next = createRunState(workflow, "sf-after-settle");
    srepo.createRun(next, { started_at: 60 });
    expect(srepo.loadRun("sf-after-settle")?.status).toBe("created");
  });

  test("the guard holds across separate connections to the same file", () => {
    // A second connection (another process in production) must see the active
    // run the first connection just inserted and refuse its own create.
    const dbB = openRunsDatabase(join(sdir, "runs.db"));
    const repoB = new RunRepository(dbB);
    try {
      const viaB = createRunState(workflow, "sf-cross-conn");
      expect(() => repoB.createRun(viaB, {})).toThrow(ActiveRunExistsError);
    } finally {
      dbB.close();
    }
  });

  test("findActiveRun picks the newest active sibling deterministically", () => {
    // Pre-guard databases can hold several active runs of one workflow; the
    // attach lookup must resolve them the same way latestRunByWorkflow does:
    // highest started_at, ties broken on the higher run_id.
    const wfDup = fromObject({ ...workflow, id: "wf-dup" }).workflow;
    for (const [id, started] of [
      ["dup-old", 100],
      ["dup-new", 200],
      ["dup-tie", 200],
    ] as const) {
      const run = createRunState(wfDup, id);
      run.status = "running";
      srepo.saveRun(run, { started_at: started }); // saveRun bypasses the guard
    }
    expect(srepo.findActiveRun("wf-dup")?.run_id).toBe("dup-tie");
    expect(srepo.findActiveRun("wf-dup", "dup-tie")?.run_id).toBe("dup-new");
    expect(srepo.findActiveRun("wf-never")).toBeUndefined();
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
