import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cmdValidate,
  cmdCompilePreview,
  cmdExplain,
  cmdRunCancel,
  cmdRunCreate,
  cmdRunLoad,
  cmdRunList,
  cmdRunListSummary,
  cmdRunRetry,
  cmdRunSave,
  cmdAdvance,
  cmdListSpecs,
} from "../src/cli/commands.ts";
import { ActiveRunExistsError } from "../src/index.ts";
import type { RunState } from "../src/index.ts";

const examplesDir = join(import.meta.dir, "../../../examples");
const example = join(examplesDir, "feature-development.workflow.yaml");
const exampleOther = join(examplesDir, "blog-daily-signals.workflow.yaml");

describe("cli command — list-specs", () => {
  test("lists workflows found under the given roots", async () => {
    const specs = await cmdListSpecs([examplesDir]);
    const ids = specs.map((s) => s.id).toSorted();
    expect(ids).toEqual(["blog-daily-signals", "feature-development"]);
    expect(specs.find((s) => s.id === "feature-development")?.trigger).toBe("manual");
  });
});

describe("cli commands — pure (offline)", () => {
  test("validate returns a passing result for a valid spec", async () => {
    const result = await cmdValidate(example);
    expect(result.valid).toBe(true);
  });

  test("compile-preview returns the Hermes plan", async () => {
    const plan = await cmdCompilePreview(example);
    expect(plan.first_node).toBe("plan");
    expect(plan.kanban_tasks.length).toBe(5);
  });

  test("explain summarises the workflow", async () => {
    const summary = await cmdExplain(example);
    expect(summary.id).toBe("feature-development");
    expect(summary.trigger).toBe("manual");
    expect(summary.nodes).toHaveLength(7);
  });
});

describe("cli commands — run lifecycle on runs.db", () => {
  let dir: string;
  let db: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hw-cli-"));
    db = join(dir, "runs.db");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("run-create persists a fresh run", async () => {
    const run = await cmdRunCreate(db, example, "run-1", "proj");
    expect(run.status).toBe("created");
    expect(run.project_id).toBe("proj");
    expect(cmdRunLoad(db, "run-1")?.run_id).toBe("run-1");
  });

  test("advance decides the entry node for a fresh run", async () => {
    const run = cmdRunLoad(db, "run-1");
    const decision = await cmdAdvance(example, run!);
    expect(decision.schedule).toEqual(["plan"]);
    expect(decision.run_status).toBe("running");
  });

  test("run-list --active includes only non-terminal runs", async () => {
    // Single-flight: run-1 must settle before another feature-development run
    // may exist, so the active list swaps rather than accumulates.
    cmdRunCancel(db, "run-1");
    await cmdRunCreate(db, example, "run-2");
    const active = cmdRunList(db, true).map((r) => r.run_id);
    expect(active).not.toContain("run-1");
    expect(active).toContain("run-2");
  });
});

describe("cli commands — single-flight guard", () => {
  let dir: string;
  let db: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hw-cli-sf-"));
    db = join(dir, "runs.db");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("run-create refuses a second run of the same workflow", async () => {
    await cmdRunCreate(db, example, "sf-a");
    await expect(cmdRunCreate(db, example, "sf-b")).rejects.toThrow(ActiveRunExistsError);
    // Another workflow is free to start.
    const other = await cmdRunCreate(db, exampleOther, "sf-other");
    expect(other.status).toBe("created");
  });

  test("whole-run retry refuses to revive next to an active sibling", async () => {
    cmdRunCancel(db, "sf-a"); // settle the first run …
    await cmdRunCreate(db, example, "sf-c"); // … and start a sibling
    expect(() => cmdRunRetry(db, "sf-a")).toThrow(ActiveRunExistsError);

    // With the sibling settled the same retry succeeds.
    cmdRunCancel(db, "sf-c");
    expect(cmdRunRetry(db, "sf-a").status).toBe("created");
  });

  test("node retry refuses to revive next to an active sibling", async () => {
    // Fail sf-a on its entry node, then start an active sibling.
    const failed = cmdRunLoad(db, "sf-a") as RunState;
    failed.status = "failed";
    failed.nodes["plan"] = { node_id: "plan", status: "failed", seq: 1 };
    cmdRunSave(db, failed);
    await cmdRunCreate(db, example, "sf-d");

    expect(() => cmdRunRetry(db, "sf-a", "plan")).toThrow(ActiveRunExistsError);

    // Retrying the active run's own failed node stays allowed (self-exclusion):
    const sibling = cmdRunLoad(db, "sf-d") as RunState;
    sibling.status = "failed";
    sibling.nodes["plan"] = { node_id: "plan", status: "failed", seq: 1 };
    cmdRunSave(db, sibling);
    expect(cmdRunRetry(db, "sf-d", "plan").status).toBe("running");
  });

  test("run-list-summary filters by workflow, newest first", async () => {
    const summaries = cmdRunListSummary(db, false, "feature-development");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((s) => s.workflow_id === "feature-development")).toBe(true);
    const started = summaries.map((s) => s.started_at ?? -1);
    expect(started).toEqual(started.toSorted((a, b) => b - a));
    expect(cmdRunListSummary(db, false, "never-ran")).toEqual([]);
    // Unfiltered keeps every workflow.
    const all = cmdRunListSummary(db, false);
    expect(all.some((s) => s.workflow_id === "blog-daily-signals")).toBe(true);
  });
});
