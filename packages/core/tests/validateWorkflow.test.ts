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
        edges: [
          { from: "a", to: "done", condition: { type: "review_status", equals: "approved" } },
        ],
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
    const w = wf(base({ nodes: [{ id: "a", type: "agent_task", prompt: "x" }], edges: [] }));
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
          {
            from: "gate",
            to: "ok",
            condition: { type: "node_status", node: "test", equals: "success" },
          },
          {
            from: "gate",
            to: "done",
            condition: { type: "node_status", node: "test", equals: "failure" },
          },
        ],
      }),
    );
    expect(validateWorkflow(w).valid).toBe(true);
  });
});

describe("validateWorkflow — input_mapping", () => {
  // a -> b -> done, with b consuming a's output by default.
  function im(
    mapping: Record<string, string>,
    bPrompt = "use {{data}}",
    extraNodes: unknown[] = [],
    extraEdges: unknown[] = [],
  ): Workflow {
    return wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "produce" },
          { id: "b", type: "agent_task", prompt: bPrompt, input_mapping: mapping },
          { id: "done", type: "finish" },
          ...extraNodes,
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "done" }, ...extraEdges],
      }),
    );
  }

  test("accepts a well-formed reference to an ancestor that the prompt uses", () => {
    expect(validateWorkflow(im({ data: "{{nodes.a.output}}" })).valid).toBe(true);
  });

  test("rejects a malformed reference", () => {
    expect(codes(im({ data: "{{nodes.a}}" }))).toContain("invalid_input_mapping_ref");
    expect(codes(im({ data: "nodes.a.output" }))).toContain("invalid_input_mapping_ref");
  });

  test("rejects a reference to an unknown node", () => {
    expect(codes(im({ data: "{{nodes.ghost.output}}" }))).toContain("unknown_input_mapping_node");
  });

  test("rejects a reference to a non-ancestor node", () => {
    // b references done, which is downstream of b, not an ancestor.
    expect(codes(im({ data: "{{nodes.done.output}}" }))).toContain("non_ancestor_input_mapping");
  });

  test("rejects a self-reference", () => {
    expect(codes(im({ data: "{{nodes.b.output}}" }))).toContain("non_ancestor_input_mapping");
  });

  test("rejects a declared placeholder the prompt never references", () => {
    expect(codes(im({ data: "{{nodes.a.output}}" }, "no placeholder here"))).toContain(
      "unused_input_mapping",
    );
  });

  // gate(human_review) -> b, with b consuming the gate's review_note.
  function gateIm(mapping: Record<string, string>): Workflow {
    return wf(
      base({
        nodes: [
          { id: "gate", type: "human_review" },
          { id: "b", type: "agent_task", prompt: "note: {{n}}", input_mapping: mapping },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "gate", to: "b" },
          { from: "b", to: "done" },
        ],
      }),
    );
  }

  test("accepts a review_note reference from a human_review ancestor", () => {
    expect(validateWorkflow(gateIm({ n: "{{nodes.gate.review_note}}" })).valid).toBe(true);
  });

  test("rejects a review_note reference from a non-human_review node", () => {
    // 'a' (agent_task) has no review_note channel.
    expect(codes(im({ data: "{{nodes.a.review_note}}" }))).toContain("review_note_source");
  });
});

describe("validateWorkflow — adopt / task_ref", () => {
  function adopt(extra: Record<string, unknown>): Workflow {
    return wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "produce" },
          { id: "drive", type: "agent_task", prompt: "drive", ...extra },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "a", to: "drive" },
          { from: "drive", to: "done" },
        ],
      }),
    );
  }

  test("accepts an adopt node with a literal task id", () => {
    expect(validateWorkflow(adopt({ adopt: true, task_ref: "t_abc123" })).valid).toBe(true);
  });

  test("accepts an adopt node with a typed task_ids reference to an ancestor", () => {
    expect(
      validateWorkflow(adopt({ adopt: true, task_ref: "{{nodes.a.output.task_ids}}" })).valid,
    ).toBe(true);
  });

  test("rejects adopt with no task_ref", () => {
    expect(codes(adopt({ adopt: true }))).toContain("adopt_without_task_ref");
  });

  test("rejects a task_ref without adopt", () => {
    expect(codes(adopt({ task_ref: "t_abc123" }))).toContain("task_ref_without_adopt");
  });

  test("accepts sequential on an adopt node", () => {
    expect(
      validateWorkflow(adopt({ adopt: true, task_ref: "t_abc123", sequential: true })).valid,
    ).toBe(true);
  });

  test("rejects sequential without adopt", () => {
    expect(codes(adopt({ sequential: true }))).toContain("sequential_without_adopt");
  });

  test("accepts an explicit sequential: false on a non-adopt node", () => {
    expect(codes(adopt({ sequential: false }))).not.toContain("sequential_without_adopt");
  });

  test("accepts stack + branch on an adopt node", () => {
    expect(
      validateWorkflow(adopt({ adopt: true, task_ref: "t_abc123", stack: true, branch: "feat/x" }))
        .valid,
    ).toBe(true);
  });

  test("rejects stack without adopt", () => {
    expect(codes(adopt({ stack: true }))).toContain("stack_without_adopt");
  });

  test("rejects branch without stack", () => {
    expect(codes(adopt({ adopt: true, task_ref: "t_abc123", branch: "feat/x" }))).toContain(
      "branch_without_stack",
    );
  });

  test("rejects a malformed task_ref", () => {
    expect(codes(adopt({ adopt: true, task_ref: "not a ref!" }))).toContain("invalid_task_ref");
  });

  test("rejects a task_ids reference to a non-ancestor node", () => {
    expect(codes(adopt({ adopt: true, task_ref: "{{nodes.done.output.task_ids}}" }))).toContain(
      "non_ancestor_task_ref",
    );
  });

  test("accepts an adopt node with a review_profile", () => {
    expect(
      validateWorkflow(adopt({ adopt: true, task_ref: "t_abc123", review_profile: "qa" })).valid,
    ).toBe(true);
  });

  test("rejects a review_profile without adopt", () => {
    expect(codes(adopt({ review_profile: "qa" }))).toContain("review_profile_without_adopt");
  });
});

describe("validateWorkflow — wait nodes", () => {
  function waitWf(extra: Record<string, unknown>): Workflow {
    return wf(
      base({
        nodes: [
          { id: "a", type: "agent_task", prompt: "open the PR" },
          { id: "merge", type: "wait", ...extra },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "a", to: "merge" },
          { from: "merge", to: "done" },
        ],
      }),
    );
  }

  test("accepts a literal PR ref", () => {
    expect(validateWorkflow(waitWf({ wait_for: { github_pr_merged: "123" } })).valid).toBe(true);
  });

  test("accepts a {{nodes.<id>.output}} ref to an ancestor", () => {
    expect(
      validateWorkflow(waitWf({ wait_for: { github_pr_merged: "{{nodes.a.output}}" } })).valid,
    ).toBe(true);
  });

  test("rejects an empty ref", () => {
    expect(codes(waitWf({ wait_for: { github_pr_merged: "  " } }))).toContain("empty_wait_ref");
  });

  test("rejects a malformed template ref", () => {
    expect(codes(waitWf({ wait_for: { github_pr_merged: "{{nodes.a}}" } }))).toContain(
      "invalid_wait_ref",
    );
  });

  test("rejects a ref to a non-ancestor node", () => {
    expect(codes(waitWf({ wait_for: { github_pr_merged: "{{nodes.done.output}}" } }))).toContain(
      "non_ancestor_wait_ref",
    );
  });
});

describe("validateWorkflow — {{params.X}} references", () => {
  test("accepts a prompt that references a declared param", () => {
    const w = wf(
      base({
        params: [{ name: "region", type: "text", label: "Region" }],
        nodes: [
          { id: "a", type: "agent_task", prompt: "deploy to {{params.region}}" },
          { id: "done", type: "finish" },
        ],
      }),
    );
    expect(codes(w)).not.toContain("unknown_param_ref");
  });

  test("rejects a prompt that references an undeclared param", () => {
    const w = wf(
      base({
        params: [{ name: "region", type: "text", label: "Region" }],
        nodes: [
          { id: "a", type: "agent_task", prompt: "deploy {{params.region}} as {{params.tier}}" },
          { id: "done", type: "finish" },
        ],
      }),
    );
    expect(codes(w)).toContain("unknown_param_ref");
  });

  test("validates param refs in prompt nodes too, not only agent_task", () => {
    const w = wf(
      base({
        params: [{ name: "region", type: "text", label: "Region" }],
        nodes: [
          { id: "p1", type: "prompt", prompt: "prep {{params.tier}}" },
          { id: "a", type: "agent_task", prompt: "run" },
          { id: "done", type: "finish" },
        ],
        edges: [
          { from: "p1", to: "a" },
          { from: "a", to: "done" },
        ],
      }),
    );
    // `tier` is undeclared and referenced from a PROMPT node -> rejected.
    expect(codes(w)).toContain("unknown_param_ref");
  });

  test("rejects a param ref when the workflow declares no params", () => {
    expect(
      codes(
        wf(
          base({
            nodes: [
              { id: "a", type: "agent_task", prompt: "use {{params.x}}" },
              { id: "done", type: "finish" },
            ],
          }),
        ),
      ),
    ).toContain("unknown_param_ref");
  });
});
