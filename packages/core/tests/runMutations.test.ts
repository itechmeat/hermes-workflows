import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cancelRun, retryRun, RetryError } from "../src/index.ts";
import { cmdRunCreate, cmdRunLoad, cmdRunCancel, cmdRunRetry } from "../src/cli/commands.ts";
import type { RunState } from "../src/index.ts";

function run(): RunState {
  return {
    run_id: "r1",
    workflow_id: "wf",
    workflow_version: 1,
    status: "running",
    nodes: {
      a: { node_id: "a", status: "completed", outcome: "success", seq: 1 },
      b: { node_id: "b", status: "failed", outcome: "failure", error: "boom", seq: 2 },
      c: { node_id: "c", status: "running", hermes_task_id: "t_c" },
      d: { node_id: "d", status: "pending" },
    },
  };
}

describe("cancelRun", () => {
  test("cancels the run and its non-terminal nodes, keeping terminal nodes", () => {
    const cancelled = cancelRun(run());
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes.a?.status).toBe("completed"); // terminal preserved
    expect(cancelled.nodes.b?.status).toBe("failed"); // terminal preserved
    expect(cancelled.nodes.c?.status).toBe("cancelled");
    expect(cancelled.nodes.d?.status).toBe("cancelled");
  });

  test("is a no-op on an already-terminal run", () => {
    const done: RunState = { ...run(), status: "completed" };
    expect(cancelRun(done)).toEqual(done);
  });

  test("does not mutate the input", () => {
    const original = run();
    cancelRun(original);
    expect(original.status).toBe("running");
    expect(original.nodes.c?.status).toBe("running");
  });
});

describe("retryRun", () => {
  test("whole-run retry resets every node to pending and the run to created", () => {
    const retried = retryRun({ ...run(), status: "failed" });
    expect(retried.status).toBe("created");
    for (const node of Object.values(retried.nodes)) {
      expect(node.status).toBe("pending");
      expect(node.outcome).toBeUndefined();
      expect(node.hermes_task_id).toBeUndefined();
    }
  });

  test("node retry resets only the failed node and resumes the run", () => {
    const retried = retryRun({ ...run(), status: "failed" }, { node: "b" });
    expect(retried.status).toBe("running");
    expect(retried.nodes.b?.status).toBe("pending");
    expect(retried.nodes.b?.outcome).toBeUndefined();
    expect(retried.nodes.a?.status).toBe("completed"); // untouched
    expect(retried.nodes.c?.status).toBe("running"); // untouched
  });

  test("node retry rejects a node that is not failed", () => {
    expect(() => retryRun(run(), { node: "a" })).toThrow(RetryError);
  });

  test("node retry rejects an unknown node", () => {
    expect(() => retryRun(run(), { node: "ghost" })).toThrow(RetryError);
  });
});

describe("cli run mutations on runs.db", () => {
  let dir: string;
  let db: string;
  const example = join(import.meta.dir, "../../../examples/feature-development.workflow.yaml");
  // feature_request is a required param on the example (no default).
  const featureParams = JSON.stringify({ feature_request: "Add a dark mode toggle" });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hw-runmut-"));
    db = join(dir, "runs.db");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("run-cancel persists a cancelled run", async () => {
    await cmdRunCreate(db, example, "run-x", undefined, undefined, undefined, featureParams);
    const cancelled = cmdRunCancel(db, "run-x");
    expect(cancelled.status).toBe("cancelled");
    expect(cmdRunLoad(db, "run-x")?.status).toBe("cancelled");
  });

  test("run-cancel on an unknown run throws", () => {
    expect(() => cmdRunCancel(db, "no-such-run")).toThrow();
  });

  test("run-retry resets a run", async () => {
    await cmdRunCreate(db, example, "run-y", undefined, undefined, undefined, featureParams);
    const retried = cmdRunRetry(db, "run-y", undefined);
    expect(retried.status).toBe("created");
  });
});
