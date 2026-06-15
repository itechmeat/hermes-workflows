import { describe, it, expect } from "vitest";
import {
  workflowToFlow,
  flowToWorkflow,
  handleToEdgeData,
  edgeSourceHandle,
  edgeConditionLabel,
  sourceHandlesFor,
  WORKFLOW_EDGE_TYPE,
} from "../src/editor/graphMapping";
import type { Workflow, UiLayout } from "../src/api/types";

const workflow: Workflow = {
  id: "deploy",
  name: "Deploy",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  defaults: { profile: "devops-engineer" },
  nodes: [
    { id: "build", type: "agent_task", prompt: "build it", profile: "devops-engineer" },
    { id: "gate", type: "human_review" },
    { id: "ship", type: "agent_task", prompt: "ship it" },
    { id: "done", type: "finish", outcome: "success" },
  ],
  edges: [
    { from: "build", to: "gate" },
    { from: "gate", to: "ship", condition: { type: "review_status", equals: "approved" } },
    { from: "gate", to: "done", fallback: true },
    { from: "ship", to: "done" },
  ],
};

const ui: UiLayout = {
  xyflow: {
    nodes: [
      { id: "build", x: 0, y: 0 },
      { id: "gate", x: 200, y: 0 },
      { id: "ship", x: 400, y: -80 },
      { id: "done", x: 600, y: 0 },
    ],
    viewport: { x: 10, y: 20, zoom: 1.5 },
  },
};

describe("graph mapping", () => {
  it("maps workflow nodes to xyflow nodes at their ui positions", () => {
    const flow = workflowToFlow(workflow, ui);
    expect(flow.nodes.map((n) => n.id)).toEqual(["build", "gate", "ship", "done"]);
    expect(flow.nodes[2]?.position).toEqual({ x: 400, y: -80 });
    // the original workflow node is carried in node data for the inspector
    expect(flow.nodes[0]?.data.node).toEqual(workflow.nodes[0]);
    expect(flow.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it("maps workflow edges to xyflow edges with stable unique ids", () => {
    const flow = workflowToFlow(workflow, ui);
    expect(flow.edges).toHaveLength(4);
    expect(new Set(flow.edges.map((e) => e.id)).size).toBe(4);
    const gateShip = flow.edges.find((e) => e.source === "gate" && e.target === "ship");
    expect(gateShip?.data?.condition).toEqual({ type: "review_status", equals: "approved" });
    const gateDone = flow.edges.find((e) => e.source === "gate" && e.target === "done");
    expect(gateDone?.data?.fallback).toBe(true);
  });

  it("falls back to a deterministic position for nodes without a ui entry", () => {
    const flow = workflowToFlow(workflow, { xyflow: { nodes: [{ id: "build", x: 5, y: 5 }] } });
    expect(flow.nodes[0]?.position).toEqual({ x: 5, y: 5 });
    // remaining nodes get deterministic, distinct fallback positions
    const positions = flow.nodes.slice(1).map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("round-trips workflow + ui losslessly when nothing is edited", () => {
    const flow = workflowToFlow(workflow, ui);
    const back = flowToWorkflow(workflow, flow.nodes, flow.edges, flow.viewport);
    expect(back.workflow).toEqual(workflow);
    expect(back.ui).toEqual(ui);
  });

  it("reflects an added edge back into the workflow", () => {
    const flow = workflowToFlow(workflow, ui);
    const extra = { id: "x", source: "build", target: "done" };
    const back = flowToWorkflow(workflow, flow.nodes, [...flow.edges, extra], flow.viewport);
    expect(back.workflow.edges).toContainEqual({ from: "build", to: "done" });
    expect(back.workflow.edges).toHaveLength(5);
  });

  it("reflects a moved node back into the ui layout", () => {
    const flow = workflowToFlow(workflow, ui);
    const moved = flow.nodes.map((n) =>
      n.id === "ship" ? { ...n, position: { x: 999, y: 1 } } : n,
    );
    const back = flowToWorkflow(workflow, moved, flow.edges, flow.viewport);
    expect(back.ui?.xyflow?.nodes).toContainEqual({ id: "ship", x: 999, y: 1 });
  });

  it("leaves each edge from the source handle that encodes its condition", () => {
    const flow = workflowToFlow(workflow, ui);
    const handle = (from: string, to: string) =>
      flow.edges.find((e) => e.source === from && e.target === to)?.sourceHandle;
    expect(handle("build", "gate")).toBe("out"); // plain fan-out
    expect(handle("gate", "ship")).toBe("approved"); // review_status
    expect(handle("gate", "done")).toBe("else"); // fallback
    // Every edge is the custom labeled type.
    expect(flow.edges.every((e) => e.type === WORKFLOW_EDGE_TYPE)).toBe(true);
  });
});

describe("conditional-edge handle mapping", () => {
  it("derives edge data from the handle an edge was drawn from", () => {
    expect(handleToEdgeData("success", "n1")).toEqual({
      condition: { type: "node_status", node: "n1", equals: "success" },
    });
    expect(handleToEdgeData("failure", "n1")).toEqual({
      condition: { type: "node_status", node: "n1", equals: "failure" },
    });
    expect(handleToEdgeData("rejected", "g")).toEqual({
      condition: { type: "review_status", equals: "rejected" },
    });
    expect(handleToEdgeData("else", "n1")).toEqual({ fallback: true });
    expect(handleToEdgeData("out", "n1")).toEqual({});
    expect(handleToEdgeData(null, "n1")).toEqual({});
  });

  it("maps an own-outcome node_status to its handle, a cross-node one to out", () => {
    expect(
      edgeSourceHandle({ condition: { type: "node_status", node: "me", equals: "failure" } }, "me"),
    ).toBe("failure");
    // Branch on ANOTHER node's status: no own handle, leaves the plain handle.
    expect(
      edgeSourceHandle(
        { condition: { type: "node_status", node: "other", equals: "success" } },
        "me",
      ),
    ).toBe("out");
    expect(edgeSourceHandle({ fallback: true }, "me")).toBe("else");
    expect(edgeSourceHandle(undefined, "me")).toBe("out");
  });

  it("labels an edge by its branch cause", () => {
    expect(edgeConditionLabel({ fallback: true }, "me")).toBe("else");
    expect(
      edgeConditionLabel({ condition: { type: "review_status", equals: "approved" } }, "g"),
    ).toBe("approved");
    expect(
      edgeConditionLabel(
        { condition: { type: "node_status", node: "me", equals: "success" } },
        "me",
      ),
    ).toBe("success");
    expect(
      edgeConditionLabel(
        { condition: { type: "node_status", node: "other", equals: "failure" } },
        "me",
      ),
    ).toBe("failure of other");
    expect(edgeConditionLabel(undefined, "me")).toBe("");
  });

  it("exposes outcome handles per node type", () => {
    expect(sourceHandlesFor("human_review").map((h) => h.id)).toEqual([
      "approved",
      "rejected",
      "needs_changes",
      "else",
      "out",
    ]);
    expect(sourceHandlesFor("agent_task").map((h) => h.id)).toEqual([
      "success",
      "failure",
      "else",
      "out",
    ]);
    expect(sourceHandlesFor("finish")).toEqual([]);
  });
});
