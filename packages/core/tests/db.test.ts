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
