import { describe, expect, test } from "bun:test";

import { fromObject, validateWorkflow } from "../src/index.ts";
import type { Workflow } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

function wf(obj: Record<string, unknown>): Workflow {
  return fromObject(obj).workflow;
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t",
    name: "T",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "a", type: "agent_task", prompt: "x" },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "a", to: "done" }],
    ...overrides,
  };
}

function codes(workflow: Workflow): string[] {
  return validateWorkflow(workflow).errors.map((e) => e.code);
}

describe("validateWorkflow — id format", () => {
  test("rejects an id with path-traversal characters", () => {
    expect(codes(wf(base({ id: "../../etc/cron.d/evil" })))).toContain("invalid_id");
    expect(codes(wf(base({ id: "a/b" })))).toContain("invalid_id");
    expect(codes(wf(base({ id: "" })))).toContain("invalid_id");
  });

  test("accepts a normal slug id", () => {
    expect(codes(wf(base({ id: "feature-development_2" })))).not.toContain("invalid_id");
  });
});

describe("validateWorkflow — examples", () => {
  test("feature-development is valid (cycle is a warning, not an error)", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("cycle");
  });

  test("blog-daily-signals is valid", async () => {
    const { workflow } = await loadExample("blog-daily-signals.workflow.yaml");
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  test("the minimal base workflow is valid", () => {
    expect(validateWorkflow(wf(base())).valid).toBe(true);
  });
});

describe("validateWorkflow — rules", () => {
  test("duplicate node id", () => {
    const w = wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "x" },
          { id: "a", type: "finish" },
        ],
        edges: [],
      }),
    );
    expect(codes(w)).toContain("duplicate_node");
  });

  test("missing profile with no defaults.profile", () => {
    const w = wf(base({ defaults: {} }));
    expect(codes(w)).toContain("missing_profile");
  });

  test("unknown edge endpoint", () => {
    const w = wf(base({ edges: [{ from: "a", to: "ghost" }] }));
    expect(codes(w)).toContain("unknown_edge_node");
  });

  test("review_status condition from a non-human_review node", () => {
    const w = wf(
      base({
        edges: [{ from: "a", to: "done", condition: { type: "review_status", equals: "approved" } }],
      }),
    );
    expect(codes(w)).toContain("review_condition_source");
  });

  test("incomplete node_status branch without fallback", () => {
    const w = wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "x" },
          { id: "b", type: "agent_task", prompt: "y" },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "a", to: "b", condition: { type: "node_status", node: "a", equals: "success" } },
          { from: "b", to: "done" },
        ],
      }),
    );
    expect(codes(w)).toContain("incomplete_branch");
  });

  test("invalid cron expression", () => {
    const w = wf(base({ trigger: { type: "cron", schedule: "not a cron" } }));
    expect(codes(w)).toContain("invalid_cron");
  });

  test("no finish node", () => {
    const w = wf(
      base({ nodes: [{ id: "a", type: "agent_task", prompt: "x" }], edges: [] }),
    );
    expect(codes(w)).toContain("no_finish");
  });

  test("multiple entry nodes", () => {
    const w = wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "x" },
          { id: "b", type: "agent_task", prompt: "y" },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "a", to: "done" },
          { from: "b", to: "done" },
        ],
      }),
    );
    expect(codes(w)).toContain("multiple_entries");
  });

  test("unreachable node", () => {
    const w = wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "x" },
          { id: "orphan", type: "agent_task", prompt: "z" },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "a", to: "done" }],
      }),
    );
    // 'orphan' is both a second entry and unreachable; assert the reachability error.
    expect(codes(w)).toContain("unreachable_node");
  });

  test("finish node with an outgoing edge", () => {
    const w = wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "x" },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "a", to: "done" },
          { from: "done", to: "a" },
        ],
      }),
    );
    expect(codes(w)).toContain("finish_has_outgoing");
  });
});

describe("validateWorkflow — script nodes", () => {
  test("a script node with an empty command is an error", () => {
    const w = wf(
      base({
        nodes: [
          { id: "lint", type: "script", command: "" },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "lint", to: "done" }],
      }),
    );
    expect(codes(w)).toContain("empty_command");
  });

  test("a whitespace-only command is an error", () => {
    const w = wf(
      base({
        nodes: [
          { id: "lint", type: "script", command: "   " },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "lint", to: "done" }],
      }),
    );
    expect(codes(w)).toContain("empty_command");
  });

  test("a script node is a legal entry node and needs no profile", () => {
    const w = wf(
      base({
        defaults: {},
        nodes: [
          { id: "build", type: "script", command: "make" },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "build", to: "done" }],
      }),
    );
    const result = validateWorkflow(w);
    expect(result.valid).toBe(true);
    expect(result.errors.map((e) => e.code)).not.toContain("missing_profile");
  });

  test("a script→condition graph branching on node_status validates", () => {
    const w = wf(
      base({
        nodes: [
          { id: "test", type: "script", command: "bun test" },
          { id: "gate", type: "condition" },
          { id: "ok", type: "finish", outcome: "success" },
          { id: "done", type: "finish", outcome: "failure" },
        ],
        edges: [
          { from: "test", to: "gate" },
          { from: "gate", to: "ok", condition: { type: "node_status", node: "test", equals: "success" } },
          { from: "gate", to: "done", condition: { type: "node_status", node: "test", equals: "failure" } },
        ],
      }),
    );
    expect(validateWorkflow(w).valid).toBe(true);
  });
});
