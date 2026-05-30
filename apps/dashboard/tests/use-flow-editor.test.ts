import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { NodeChange, EdgeChange, Connection } from "@xyflow/react";
import { useFlowEditor } from "../src/editor/useFlowEditor";
import type { WorkflowsApi } from "../src/api/client";
import type { SpecDetail, Workflow, UiLayout } from "../src/api/types";

const workflow: Workflow = {
  id: "deploy",
  name: "Deploy",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  defaults: { profile: "devops-engineer" },
  nodes: [
    { id: "build", type: "agent_task", prompt: "build it", profile: "devops-engineer" },
    { id: "done", type: "finish", outcome: "success" },
  ],
  edges: [{ from: "build", to: "done" }],
};

const ui: UiLayout = {
  xyflow: {
    nodes: [
      { id: "build", x: 0, y: 0 },
      { id: "done", x: 200, y: 0 },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
};

const detail: SpecDetail = { workflow, ui, path: "/x/deploy.workflow.yaml" };

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    saveWorkflow: vi.fn(async (_id: string, body: { workflow: Workflow; ui?: UiLayout }) => ({
      workflow: body.workflow,
      ui: body.ui,
      path: detail.path,
    })),
    ...overrides,
  } as unknown as WorkflowsApi;
}

describe("useFlowEditor", () => {
  it("initialises from the spec and starts clean", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["build", "done"]);
    expect(result.current.edges).toHaveLength(1);
    expect(result.current.dirty).toBe(false);
  });

  it("marks dirty on a connect and adds the edge", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    const connection: Connection = {
      source: "done",
      target: "build",
      sourceHandle: null,
      targetHandle: null,
    };
    act(() => result.current.onConnect(connection));
    expect(result.current.dirty).toBe(true);
    expect(result.current.edges).toHaveLength(2);
  });

  it("marks dirty on a node move but not on measurement or selection", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));

    act(() =>
      result.current.onNodesChange([
        { type: "dimensions", id: "build", dimensions: { width: 10, height: 10 } } as NodeChange,
        { type: "select", id: "build", selected: true } as NodeChange,
      ]),
    );
    expect(result.current.dirty).toBe(false);

    act(() =>
      result.current.onNodesChange([
        { type: "position", id: "build", position: { x: 50, y: 60 } } as NodeChange,
      ]),
    );
    expect(result.current.dirty).toBe(true);
  });

  it("marks dirty on an edge removal", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    act(() =>
      result.current.onEdgesChange([
        { type: "remove", id: result.current.edges[0]!.id } as EdgeChange,
      ]),
    );
    expect(result.current.dirty).toBe(true);
    expect(result.current.edges).toHaveLength(0);
  });

  it("saves the round-tripped workflow + ui and clears dirty", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useFlowEditor(detail, client));

    await act(async () => {
      await result.current.save();
    });

    expect(client.saveWorkflow).toHaveBeenCalledTimes(1);
    const [id, body] = (client.saveWorkflow as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe("deploy");
    expect(body.workflow).toEqual(workflow);
    expect(body.ui).toEqual(ui);
    expect(result.current.dirty).toBe(false);
  });

  it("selects a node and exposes it", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    expect(result.current.selectedNode).toBeNull();
    act(() => result.current.selectNode("build"));
    expect(result.current.selectedNode?.id).toBe("build");
  });

  it("updates a node field and marks dirty", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    act(() => result.current.updateNode("build", { prompt: "rebuild it" }));
    const build = result.current.nodes.find((n) => n.id === "build")!;
    expect((build.data.node as { prompt: string }).prompt).toBe("rebuild it");
    expect(result.current.dirty).toBe(true);
  });

  it("adds a node of the requested type, selects it, and marks dirty", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    let id = "";
    act(() => {
      id = result.current.addNode("condition");
    });
    expect(id).toBe("condition-1");
    const added = result.current.nodes.find((n) => n.id === id);
    expect(added?.data.node.type).toBe("condition");
    expect(result.current.selectedNode?.id).toBe(id);
    expect(result.current.dirty).toBe(true);
  });

  it("keeps dirty and reports an error when save fails", async () => {
    const client = stubClient({
      saveWorkflow: vi.fn(async () => {
        throw new Error("invalid graph");
      }),
    });
    const { result } = renderHook(() => useFlowEditor(detail, client));
    act(() => result.current.onConnect({ source: "done", target: "build", sourceHandle: null, targetHandle: null }));

    await act(async () => {
      await result.current.save();
    });

    await waitFor(() => expect(result.current.status?.kind).toBe("error"));
    expect(result.current.dirty).toBe(true);
  });
});
