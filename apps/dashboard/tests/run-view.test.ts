import { describe, it, expect } from "vitest";
import { isTerminalRun, statusColor, applyRunStatus } from "../src/run/runView";
import type { RunState, SpecDetail, Workflow, UiLayout } from "../src/api/types";

const workflow: Workflow = {
  id: "deploy",
  name: "Deploy",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  nodes: [
    { id: "build", type: "agent_task", prompt: "x", profile: "dev" },
    { id: "done", type: "finish" },
  ],
  edges: [{ from: "build", to: "done" }],
};
const ui: UiLayout = {
  xyflow: {
    nodes: [
      { id: "build", x: 0, y: 0 },
      { id: "done", x: 200, y: 0 },
    ],
  },
};
const detail: SpecDetail = { workflow, ui, path: "/x/deploy.workflow.yaml" };

const run: RunState = {
  run_id: "deploy-1",
  workflow_id: "deploy",
  workflow_version: 1,
  status: "running",
  nodes: {
    build: { node_id: "build", status: "running" },
    done: { node_id: "done", status: "pending" },
  },
};

describe("run view helpers", () => {
  it("classifies terminal vs active run statuses", () => {
    expect(isTerminalRun("completed")).toBe(true);
    expect(isTerminalRun("failed")).toBe(true);
    expect(isTerminalRun("cancelled")).toBe(true);
    expect(isTerminalRun("running")).toBe(false);
    expect(isTerminalRun("waiting")).toBe(false);
    expect(isTerminalRun("created")).toBe(false);
  });

  it("gives a distinct colour per node status", () => {
    expect(statusColor("completed")).not.toBe(statusColor("failed"));
    expect(statusColor("running")).not.toBe(statusColor("pending"));
  });

  it("overlays run node statuses onto the flow nodes", () => {
    const { nodes, edges } = applyRunStatus(detail, run);
    expect(edges).toHaveLength(1);
    const build = nodes.find((n) => n.id === "build");
    const done = nodes.find((n) => n.id === "done");
    expect(build?.data.status).toBe("running");
    expect(done?.data.status).toBe("pending");
    // the workflow node is still carried for the detail view
    expect(build?.data.node.id).toBe("build");
  });

  it("leaves status undefined for nodes the run has not reached", () => {
    const partial: RunState = {
      ...run,
      nodes: { build: { node_id: "build", status: "completed" } },
    };
    const { nodes } = applyRunStatus(detail, partial);
    expect(nodes.find((n) => n.id === "done")?.data.status).toBeUndefined();
  });
});
