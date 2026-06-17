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
    edges: [
      { from: "a", to: "done", condition: { type: "node_status", node: "a", equals: "success" } },
    ],
  }).workflow;

  test("a failure with no matching edge fails the run", () => {
    const run = createRunState(stuck, "r");
    run.status = "running";
    complete(run, "a", "failure", 1);
    expect(advance(stuck, run).run_status).toBe("failed");
  });
});

describe("advance — abort_run hard-stop", () => {
  const wf = fromObject({
    id: "abort",
    name: "Abort",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "a", type: "agent_task", prompt: "x" },
      { id: "build", type: "agent_task", prompt: "y" },
      { id: "done", type: "finish" },
    ],
    // Plain edges always fire: without abort_run, 'a' would route to build.
    edges: [
      { from: "a", to: "build" },
      { from: "build", to: "done" },
    ],
  }).workflow;

  test("a node flagged abort_run fails the run and does not route onward", () => {
    const run = createRunState(wf, "r");
    run.status = "running";
    // 'a' settled failure AND flagged to abort (e.g. an adopt that drove 0 cards).
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "failure",
      abort_run: true,
      seq: 1,
    };
    const result = advance(wf, run);
    expect(result.run_status).toBe("failed");
    expect(result.schedule).not.toContain("build");
    expect(result.node_updates["build"]).toBeUndefined();
  });

  test("without abort_run the same node routes onward (regression guard)", () => {
    const run = createRunState(wf, "r");
    run.status = "running";
    complete(run, "a", "failure", 1);
    const result = advance(wf, run);
    expect(result.schedule).toContain("build");
    expect(result.run_status).toBe("running");
  });

  test("abort_run closes the run as failed even while another node is still active", () => {
    const run = createRunState(wf, "r");
    run.status = "running";
    // 'a' aborts the run, but a parallel node is still running this tick: the
    // abort is a hard stop and must not be masked by the active node.
    run.nodes["a"] = {
      node_id: "a",
      status: "completed",
      outcome: "failure",
      abort_run: true,
      seq: 1,
    };
    run.nodes["build"] = { node_id: "build", status: "running", seq: 0 };
    expect(advance(wf, run).run_status).toBe("failed");
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
      {
        from: "gate",
        to: "ok",
        condition: { type: "node_status", node: "build", equals: "success" },
      },
      {
        from: "gate",
        to: "bad",
        condition: { type: "node_status", node: "build", equals: "failure" },
      },
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

  test("a scheduled script step is inline-eligible", () => {
    // The fresh run schedules only the `build` script node — inline-eligible,
    // so the engine may advance it synchronously without a tick round-trip.
    expect(advance(scriptWf, createRunState(scriptWf, "r")).inline_eligible).toBe(true);
  });

  test("a tick that schedules nothing is not inline-eligible", () => {
    const run = createRunState(scriptWf, "r");
    run.status = "running";
    run.nodes["build"] = { node_id: "build", status: "scheduled" };
    const result = advance(scriptWf, run);
    expect(result.schedule).toEqual([]);
    expect(result.inline_eligible).toBe(false);
  });
});

describe("advance — inline eligibility with agent and mixed steps", () => {
  const mixedWf = fromObject({
    id: "mixed-inline",
    name: "Mixed Inline",
    version: 1,
    scope: { type: "project" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "start", type: "script", command: "echo go" },
      { id: "agent", type: "agent_task", prompt: "do" },
      { id: "lint", type: "script", command: "lint" },
      { id: "done", type: "finish", outcome: "success" },
    ],
    edges: [
      { from: "start", to: "agent" },
      { from: "start", to: "lint" },
      { from: "agent", to: "done" },
      { from: "lint", to: "done" },
    ],
  }).workflow;

  test("a step that schedules an agent_task is not inline-eligible", () => {
    const run = createRunState(mixedWf, "r");
    run.status = "running";
    complete(run, "start", "success", 1);
    const result = advance(mixedWf, run);
    // `start` fans out to both an agent_task and a script: a single durable
    // node in the scheduled set makes the whole tick ineligible for inline.
    expect(result.schedule.toSorted()).toEqual(["agent", "lint"]);
    expect(result.inline_eligible).toBe(false);
  });
});

describe("advance — wait nodes", () => {
  const waitWf = fromObject({
    id: "w",
    name: "W",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "merge", type: "wait", wait_for: { github_pr_merged: "123" } },
      { id: "ok", type: "finish", outcome: "success" },
      { id: "bad", type: "finish", outcome: "failure" },
    ],
    edges: [
      {
        from: "merge",
        to: "ok",
        condition: { type: "node_status", node: "merge", equals: "success" },
      },
      {
        from: "merge",
        to: "bad",
        condition: { type: "node_status", node: "merge", equals: "failure" },
      },
    ],
  }).workflow;

  test("a wait entry node parks active (running), not scheduled", () => {
    const result = advance(waitWf, createRunState(waitWf, "r"));
    expect(result.schedule).toEqual([]);
    expect(result.node_updates["merge"]).toBe("running");
    expect(result.run_status).toBe("running");
  });

  test("a running wait node is not re-activated (idempotent)", () => {
    const run = createRunState(waitWf, "r");
    run.status = "running";
    run.nodes["merge"] = { node_id: "merge", status: "running" };
    const result = advance(waitWf, run);
    expect(result.schedule).toEqual([]);
    expect(result.node_updates["merge"]).toBeUndefined();
  });

  test("a settled wait node routes on its outcome", () => {
    const run = createRunState(waitWf, "r");
    run.status = "running";
    run.nodes["merge"] = { node_id: "merge", status: "completed", outcome: "success", seq: 1 };
    const ok = advance(waitWf, run);
    expect(ok.node_updates["ok"]).toBe("completed");
    expect(ok.run_status).toBe("completed");

    run.nodes["merge"] = { node_id: "merge", status: "completed", outcome: "failure", seq: 1 };
    const bad = advance(waitWf, run);
    expect(bad.node_updates["bad"]).toBe("completed");
    expect(bad.run_status).toBe("failed");
  });
});

describe("advance — prompt node", () => {
  // A prompt node is routing-only: it resolves instantly and follows its edge,
  // so a fresh run with a Prompt entry node schedules its downstream agent_task
  // in the same tick (the prompt node itself runs no worker).
  const promptFlow = fromObject({
    id: "pf",
    name: "PF",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "p", type: "prompt", prompt: "primary instruction" },
      { id: "a", type: "agent_task", prompt: "work" },
      { id: "done", type: "finish" },
    ],
    edges: [
      { from: "p", to: "a" },
      { from: "a", to: "done" },
    ],
  }).workflow;

  test("a Prompt entry node resolves instantly and schedules its downstream agent_task", () => {
    const result = advance(promptFlow, createRunState(promptFlow, "r1"));
    expect(result.node_updates["p"]).toBe("completed");
    expect(result.schedule).toEqual(["a"]);
    expect(result.run_status).toBe("running");
  });
});
