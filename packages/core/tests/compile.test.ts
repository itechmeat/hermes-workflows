import { describe, expect, test } from "bun:test";

import { compileToHermesPlan, fromObject } from "../src/index.ts";
import type { Workflow } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

function wf(nodes: unknown[], edges: unknown[]): Workflow {
  return fromObject({
    id: "t",
    name: "T",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes,
    edges,
  }).workflow;
}

describe("compileToHermesPlan — notifications", () => {
  test("subscribe_cards defaults to true and reflects the opt-out", () => {
    const base = {
      id: "n",
      name: "N",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      defaults: { profile: "p" },
      nodes: [
        { id: "a", type: "agent_task", prompt: "x" },
        { id: "done", type: "finish" },
      ],
      edges: [{ from: "a", to: "done" }],
    };
    expect(compileToHermesPlan(fromObject(base).workflow).subscribe_cards).toBe(true);
    const off = fromObject({ ...base, notifications: { subscribe_cards: false } }).workflow;
    expect(compileToHermesPlan(off).subscribe_cards).toBe(false);
  });

  test("carries a node's notify_completion override onto its compiled task", () => {
    const wf = fromObject({
      id: "n",
      name: "N",
      version: 1,
      scope: { type: "project" },
      trigger: { type: "manual" },
      defaults: { profile: "p" },
      nodes: [
        { id: "loud", type: "agent_task", prompt: "x", notify_completion: true },
        { id: "quiet", type: "agent_task", prompt: "y", notify_completion: false },
        { id: "default", type: "agent_task", prompt: "z" },
        { id: "done", type: "finish" },
      ],
      edges: [
        { from: "loud", to: "quiet" },
        { from: "quiet", to: "default" },
        { from: "default", to: "done" },
      ],
    }).workflow;
    const byNode = Object.fromEntries(
      compileToHermesPlan(wf).kanban_tasks.map((t) => [t.node, t.notify_completion]),
    );
    expect(byNode["loud"]).toBe(true);
    expect(byNode["quiet"]).toBe(false);
    // Unset stays absent on the compiled task: the engine then inherits the
    // workflow-level subscribe_cards default.
    expect(byNode["default"]).toBeUndefined();
  });
});

describe("compileToHermesPlan — wait nodes", () => {
  test("a wait node compiles to a wait_step, not a Kanban task", () => {
    const workflow = wf(
      [
        { id: "merge", type: "wait", wait_for: { github_pr_merged: "123" }, timeout_seconds: 600 },
        { id: "done", type: "finish" },
      ],
      [{ from: "merge", to: "done" }],
    );
    const plan = compileToHermesPlan(workflow);
    expect(plan.kanban_tasks).toHaveLength(0);
    expect(plan.wait_steps).toEqual([
      { node: "merge", kind: "wait", wait_for: { github_pr_merged: "123" }, timeout_seconds: 600 },
    ]);
  });
});

describe("compileToHermesPlan", () => {
  test("feature-development compiles to Kanban tasks with no cron", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const plan = compileToHermesPlan(workflow);

    expect(plan.first_node).toBe("plan");
    expect(plan.cron_jobs).toHaveLength(0);
    expect(plan.kanban_tasks.map((t) => t.node)).toEqual([
      "plan",
      "implement",
      "validate",
      "fix",
      "release_notes",
    ]);
    expect(plan.kanban_tasks[0]).toMatchObject({
      node: "plan",
      assignee: "product-tech-lead",
      workflow_template_id: "feature-development",
      current_step_key: "plan",
      title: "Plan feature",
    });
    expect(plan.kanban_tasks[0]?.prompt).toContain("implementation plan");
    const implement = plan.kanban_tasks.find((t) => t.node === "implement");
    expect(implement?.workspace).toBe("worktree");
    expect(plan.profiles).toContain("qa-engineer");
    expect(plan.memory).toEqual({ provider: "auto", fail_open: true });
    expect(plan.scope).toEqual({ type: "project" });
  });

  test("a global workflow carries its scope through to the plan", async () => {
    const { workflow } = await loadExample("blog-daily-signals.workflow.yaml");
    const plan = compileToHermesPlan(workflow);
    expect(plan.scope.type).toBe("global");
  });

  test("blog-daily-signals compiles a cron job", async () => {
    const { workflow } = await loadExample("blog-daily-signals.workflow.yaml");
    const plan = compileToHermesPlan(workflow);

    expect(plan.cron_jobs).toEqual([
      {
        schedule: "0 9 * * *",
        timezone: "Europe/Belgrade",
        command: "hermes-workflows run blog-daily-signals",
      },
    ]);
    expect(plan.first_node).toBe("fetch");
  });
});

describe("compileToHermesPlan — script steps", () => {
  test("a mixed workflow splits agent_task and script into typed, kind-tagged lists", () => {
    const plan = compileToHermesPlan(
      wf(
        [
          { id: "work", type: "agent_task", prompt: "do" },
          {
            id: "lint",
            type: "script",
            command: "bun run lint",
            workdir: "/srv/projects/foo",
            timeout_seconds: 90,
            env: ["PATH"],
          },
          { id: "done", type: "finish" },
        ],
        [
          { from: "work", to: "lint" },
          { from: "lint", to: "done" },
        ],
      ),
    );

    expect(plan.kanban_tasks).toHaveLength(1);
    expect(plan.kanban_tasks[0]).toMatchObject({ node: "work", kind: "agent" });

    expect(plan.script_steps).toHaveLength(1);
    expect(plan.script_steps[0]).toEqual({
      node: "lint",
      kind: "script",
      command: "bun run lint",
      workdir: "/srv/projects/foo",
      timeout_seconds: 90,
      env: ["PATH"],
    });
  });

  test("a script-only workflow yields no kanban tasks", () => {
    const plan = compileToHermesPlan(
      wf(
        [
          { id: "build", type: "script", command: "make" },
          { id: "done", type: "finish" },
        ],
        [{ from: "build", to: "done" }],
      ),
    );
    expect(plan.kanban_tasks).toHaveLength(0);
    expect(plan.script_steps.map((s) => s.node)).toEqual(["build"]);
    expect(plan.script_steps[0]).toEqual({ node: "build", kind: "script", command: "make" });
  });
});

describe("compileToHermesPlan — input_mapping", () => {
  test("carries a node's input_mapping onto its compiled task", () => {
    const plan = compileToHermesPlan(
      wf(
        [
          { id: "a", type: "agent_task", prompt: "produce" },
          {
            id: "b",
            type: "agent_task",
            prompt: "use {{data}}",
            input_mapping: { data: "{{nodes.a.output}}" },
          },
          { id: "done", type: "finish" },
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "done" },
        ],
      ),
    );
    const a = plan.kanban_tasks.find((t) => t.node === "a");
    const b = plan.kanban_tasks.find((t) => t.node === "b");
    expect(b?.input_mapping).toEqual({ data: "{{nodes.a.output}}" });
    // A node without a mapping carries none (the field stays absent, not {}).
    expect(a?.input_mapping).toBeUndefined();
  });
});
