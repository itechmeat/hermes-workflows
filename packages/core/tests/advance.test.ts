import { describe, expect, test } from "bun:test";

import { advance, createRunState, fromObject } from "../src/index.ts";
import type { RunState, NodeOutcome, ReviewOption } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

const { workflow } = await loadExample("feature-development.workflow.yaml");

function start(): RunState {
  return createRunState(workflow, "r1");
}
function complete(run: RunState, id: string, outcome: NodeOutcome, seq: number): void {
  run.nodes[id] = { node_id: id, status: "completed", outcome, seq };
}
function decide(run: RunState, id: string, decision: ReviewOption, seq: number): void {
  run.nodes[id] = { node_id: id, status: "waiting_for_review", review_decision: decision, seq };
}

describe("advance — happy path", () => {
  test("schedules the entry node from a fresh run", () => {
    const result = advance(workflow, start());
    expect(result.schedule).toEqual(["plan"]);
    expect(result.run_status).toBe("running");
    expect(result.node_updates["plan"]).toBe("scheduled");
  });

  test("is idempotent: a scheduled entry node is not re-scheduled", () => {
    const run = start();
    run.status = "running";
    run.nodes["plan"] = { node_id: "plan", status: "scheduled" };
    const result = advance(workflow, run);
    expect(result.schedule).toEqual([]);
    expect(result.run_status).toBe("running");
  });

  test("plan success schedules implement", () => {
    const run = start();
    run.status = "running";
    complete(run, "plan", "success", 1);
    expect(advance(workflow, run).schedule).toEqual(["implement"]);
  });

  test("validate success routes to the human_review node and waits", () => {
    const run = start();
    run.status = "running";
    complete(run, "plan", "success", 1);
    complete(run, "implement", "success", 2);
    complete(run, "validate", "success", 3);
    const result = advance(workflow, run);
    expect(result.waiting).toEqual(["review"]);
    expect(result.schedule).toEqual([]);
    expect(result.run_status).toBe("waiting");
  });
});

describe("advance — branching and loops", () => {
  test("validate failure schedules fix", () => {
    const run = start();
    run.status = "running";
    complete(run, "plan", "success", 1);
    complete(run, "implement", "success", 2);
    complete(run, "validate", "failure", 3);
    expect(advance(workflow, run).schedule).toEqual(["fix"]);
  });

  test("fix completion re-runs validate via the loop edge", () => {
    const run = start();
    run.status = "running";
    complete(run, "plan", "success", 1);
    complete(run, "implement", "success", 2);
    complete(run, "validate", "failure", 3);
    complete(run, "fix", "success", 4);
    const result = advance(workflow, run);
    expect(result.schedule).toEqual(["validate"]);
    expect(result.node_updates["validate"]).toBe("scheduled");
  });
});

describe("advance — review and finish", () => {
  test("an approved review schedules release_notes", () => {
    const run = start();
    run.status = "waiting";
    complete(run, "plan", "success", 1);
    complete(run, "implement", "success", 2);
    complete(run, "validate", "success", 3);
    decide(run, "review", "approved", 4);
    expect(advance(workflow, run).schedule).toEqual(["release_notes"]);
  });

  test("reaching finish completes the run", () => {
    const run = start();
    run.status = "running";
    complete(run, "plan", "success", 1);
    complete(run, "implement", "success", 2);
    complete(run, "validate", "success", 3);
    decide(run, "review", "approved", 4);
    complete(run, "release_notes", "success", 5);
    const result = advance(workflow, run);
    expect(result.run_status).toBe("completed");
    expect(result.finish_outcome).toBe("success");
  });
});

describe("advance — dead end", () => {
  const stuck = fromObject({
    id: "stuck",
    name: "Stuck",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "a", type: "agent_task", prompt: "x" },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "a", to: "done", condition: { type: "node_status", node: "a", equals: "success" } }],
  }).workflow;

  test("a failure with no matching edge fails the run", () => {
    const run = createRunState(stuck, "r");
    run.status = "running";
    complete(run, "a", "failure", 1);
    expect(advance(stuck, run).run_status).toBe("failed");
  });
});

describe("advance — script nodes", () => {
  const scriptWf = fromObject({
    id: "scripts",
    name: "Scripts",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    nodes: [
      { id: "build", type: "script", command: "make" },
      { id: "gate", type: "condition" },
      { id: "ok", type: "finish", outcome: "success" },
      { id: "bad", type: "finish", outcome: "failure" },
    ],
    edges: [
      { from: "build", to: "gate" },
      { from: "gate", to: "ok", condition: { type: "node_status", node: "build", equals: "success" } },
      { from: "gate", to: "bad", condition: { type: "node_status", node: "build", equals: "failure" } },
    ],
  }).workflow;

  test("schedules a script entry node like a work node", () => {
    const result = advance(scriptWf, createRunState(scriptWf, "r"));
    expect(result.schedule).toEqual(["build"]);
    expect(result.node_updates["build"]).toBe("scheduled");
    expect(result.run_status).toBe("running");
  });

  test("a script success routes through the condition to the success finish", () => {
    const run = createRunState(scriptWf, "r");
    run.status = "running";
    complete(run, "build", "success", 1);
    expect(advance(scriptWf, run).run_status).toBe("completed");
  });

  test("a script failure routes to the failure finish", () => {
    const run = createRunState(scriptWf, "r");
    run.status = "running";
    complete(run, "build", "failure", 1);
    expect(advance(scriptWf, run).run_status).toBe("failed");
  });
});
