import { describe, expect, test } from "bun:test";

import { buildRetrospective, createRunState, fromObject } from "../src/index.ts";
import type { RunState } from "../src/index.ts";

const { workflow } = fromObject({
  id: "retro-wf",
  name: "Retro WF",
  version: 1,
  scope: { type: "project", projects: ["acme"] },
  trigger: { type: "manual" },
  defaults: { profile: "p" },
  nodes: [
    { id: "build", type: "agent_task", prompt: "build it", title: "Build" },
    { id: "review", type: "human_review" },
    { id: "ship", type: "script", command: "deploy" },
    { id: "done", type: "finish", outcome: "success" },
  ],
  edges: [
    { from: "build", to: "review" },
    { from: "review", to: "ship" },
    { from: "ship", to: "done" },
  ],
});

function run(status: RunState["status"]): RunState {
  const r = createRunState(workflow, "retro-1", "acme");
  r.status = status;
  return r;
}

describe("buildRetrospective", () => {
  test("a completed run renders the result and per-node outcomes", () => {
    const r = run("completed");
    r.nodes["build"] = {
      node_id: "build",
      status: "completed",
      outcome: "success",
      seq: 1,
      output: "built ok",
    };
    r.nodes["review"] = {
      node_id: "review",
      status: "completed",
      review_decision: "approved",
      seq: 2,
    };
    r.nodes["ship"] = {
      node_id: "ship",
      status: "completed",
      outcome: "success",
      seq: 3,
      output: "deployed",
    };
    r.nodes["done"] = { node_id: "done", status: "completed", seq: 4 };

    const retro = buildRetrospective(workflow, r);
    expect(retro.title).toContain("retro-1");
    const md = retro.markdown;
    expect(md).toContain("Retro WF");
    expect(md).toContain("acme"); // project
    expect(md).toContain("completed"); // result
    expect(md).toContain("Build"); // node title in "What happened"
    expect(md).toContain("approved"); // review decision under Decisions
    // a clean run records no problems
    expect(md.toLowerCase()).toContain("none");
  });

  test("a failed run surfaces the failing node under Problems", () => {
    const r = run("failed");
    r.nodes["build"] = {
      node_id: "build",
      status: "failed",
      outcome: "failure",
      seq: 1,
      error: "compile error",
      output: "tsc blew up",
    };

    const retro = buildRetrospective(workflow, r);
    const problems = retro.markdown.split("## Problems")[1] ?? "";
    expect(retro.markdown).toContain("failed");
    expect(problems).toContain("build");
    expect(problems).toContain("compile error");
  });
});
