import { describe, it, expect } from "vitest";
import {
  isTerminalRun,
  statusColor,
  applyRunStatus,
  overlayRunStatus,
  shouldHandOff,
  RUN_NODE_TYPE,
} from "../src/run/runView";
import { workflowToFlow } from "../src/editor/graphMapping";
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

  it("tags run-view nodes with the run node type for the shared registry", () => {
    const { nodes } = applyRunStatus(detail, run);
    expect(nodes.every((n) => n.type === RUN_NODE_TYPE)).toBe(true);
  });

  it("overlays run status onto already-mapped flow nodes, keeping positions", () => {
    const flow = workflowToFlow(workflow, ui);
    const moved = flow.nodes.map((n) =>
      n.id === "build" ? { ...n, position: { x: 999, y: 7 } } : n,
    );
    const overlaid = overlayRunStatus(moved, run);
    const build = overlaid.find((n) => n.id === "build");
    expect(build?.type).toBe(RUN_NODE_TYPE);
    expect(build?.position).toEqual({ x: 999, y: 7 });
    expect(build?.data.status).toBe("running");
    expect(overlaid.find((n) => n.id === "done")?.data.status).toBe("pending");
  });

  it("hands off to the run inspector on terminal and waiting statuses only", () => {
    expect(shouldHandOff("completed")).toBe(true);
    expect(shouldHandOff("failed")).toBe(true);
    expect(shouldHandOff("cancelled")).toBe(true);
    // human_review parks the run in `waiting`; the editor has no review
    // controls, so playback hands over instead of stalling forever.
    expect(shouldHandOff("waiting")).toBe(true);
    expect(shouldHandOff("created")).toBe(false);
    expect(shouldHandOff("running")).toBe(false);
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
