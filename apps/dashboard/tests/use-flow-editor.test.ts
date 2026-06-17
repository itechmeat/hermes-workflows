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

  it("connecting from a labeled handle conditions the new edge", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    act(() =>
      result.current.onConnect({
        source: "build",
        target: "done",
        sourceHandle: "failure",
        targetHandle: null,
      }),
    );
    // A second edge build->done, from a different (failure) handle, is added
    // alongside the pre-existing plain one.
    const edge = result.current.edges.find((e) => e.sourceHandle === "failure");
    expect(edge?.data?.condition).toEqual({
      type: "node_status",
      node: "build",
      equals: "failure",
    });
  });

  it("updateEdge sets the branch and repositions it onto the encoding handle", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    const edgeId = result.current.edges[0]!.id;
    act(() => result.current.updateEdge(edgeId, { fallback: true }));
    // The id encodes the handle, so re-handling regenerates it; find by source.
    const edge = result.current.edges.find((e) => e.source === "build");
    expect(edge?.data).toEqual({ fallback: true });
    expect(edge?.sourceHandle).toBe("else");
    expect(result.current.dirty).toBe(true);
  });

  it("updateEdge resyncs the edge id so a re-handled edge cannot collide", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    // Move the existing plain build->done edge onto the `else` handle.
    const original = result.current.edges[0]!;
    act(() => result.current.updateEdge(original.id, { fallback: true }));
    const moved = result.current.edges.find((e) => e.source === "build")!;
    expect(moved.id).not.toBe(original.id); // id followed the handle change
    // Now draw a fresh plain (out) edge build->done: it must not reuse the moved
    // edge's id, so ids stay unique and select/remove stays unambiguous.
    act(() =>
      result.current.onConnect({
        source: "build",
        target: "done",
        sourceHandle: "out",
        targetHandle: null,
      }),
    );
    const ids = result.current.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("removeEdge deletes the edge and clears its selection", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    const edgeId = result.current.edges[0]!.id;
    act(() => result.current.selectEdge(edgeId));
    expect(result.current.selectedEdge?.id).toBe(edgeId);
    act(() => result.current.removeEdge(edgeId));
    expect(result.current.edges).toHaveLength(0);
    expect(result.current.selectedEdge).toBeNull();
    expect(result.current.dirty).toBe(true);
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

  it("tracks the viewport on pan/zoom but does not mark the graph dirty", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));

    // programmatic fitView fires onMoveEnd with a null event
    act(() => result.current.onMoveEnd(null, { x: 1, y: 2, zoom: 1.5 }));
    expect(result.current.dirty).toBe(false);

    // a user pan/zoom carries an event: the viewport is tracked so a later
    // save persists the current view, but panning the canvas is not itself a
    // workflow change and must not dirty an otherwise-untouched graph.
    const panned = { x: 9, y: 9, zoom: 2 };
    act(() => result.current.onMoveEnd(new MouseEvent("mouseup"), panned));
    expect(result.current.dirty).toBe(false);
    expect(result.current.viewport).toEqual(panned);
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
    // node ids are sequential numbers (no type prefix)
    expect(id).toMatch(/^\d+$/);
    const added = result.current.nodes.find((n) => n.id === id);
    expect(added?.data.node.type).toBe("condition");
    expect(result.current.selectedNode?.id).toBe(id);
    expect(result.current.dirty).toBe(true);
  });

  it("defaults a new agent_task to max_retries 3", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    let id = "";
    act(() => {
      id = result.current.addNode("agent_task");
    });
    const added = result.current.nodes.find((n) => n.id === id);
    expect(added?.data.node).toMatchObject({ type: "agent_task", max_retries: 3 });
  });

  it("duplicates a node under a fresh id, copying fields at an offset, and selects it", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    let newId = "";
    act(() => {
      newId = result.current.duplicateNode("build")!;
    });

    // a fresh slug-valid id, distinct from the source
    expect(newId).not.toBe("build");
    expect(result.current.nodes.map((n) => n.id)).toContain(newId);
    expect(result.current.nodes).toHaveLength(3);

    const source = result.current.nodes.find((n) => n.id === "build")!;
    const clone = result.current.nodes.find((n) => n.id === newId)!;
    // copied fields (id rewritten), offset position
    expect(clone.data.node).toEqual({ ...source.data.node, id: newId });
    expect(clone.position.x).toBeGreaterThan(source.position.x);
    expect(clone.position.y).toBeGreaterThan(source.position.y);

    expect(result.current.selectedNode?.id).toBe(newId);
    expect(result.current.dirty).toBe(true);
  });

  it("auto-layouts nodes into ranks, marks dirty, and round-trips the positions on save", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useFlowEditor(detail, client));

    act(() => result.current.applyLayout());

    const build = result.current.nodes.find((n) => n.id === "build")!;
    const done = result.current.nodes.find((n) => n.id === "done")!;
    // build -> done is linear, so done lands one rank to the right of build
    expect(done.position.x).toBeGreaterThan(build.position.x);
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });
    const [, body] = (client.saveWorkflow as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const doneUi = body.ui!.xyflow!.nodes!.find((n: { id: string }) => n.id === "done")!;
    expect(doneUi.x).toBe(done.position.x);
  });

  it("returns null when duplicating an unknown node", () => {
    const { result } = renderHook(() => useFlowEditor(detail, stubClient()));
    let out: string | null = "x";
    act(() => {
      out = result.current.duplicateNode("ghost");
    });
    expect(out).toBeNull();
    expect(result.current.nodes).toHaveLength(2);
  });

  it("keeps dirty and reports an error when save fails", async () => {
    const client = stubClient({
      saveWorkflow: vi.fn(async () => {
        throw new Error("invalid graph");
      }),
    });
    const { result } = renderHook(() => useFlowEditor(detail, client));
    act(() =>
      result.current.onConnect({
        source: "done",
        target: "build",
        sourceHandle: null,
        targetHandle: null,
      }),
    );

    await act(async () => {
      await result.current.save();
    });

    await waitFor(() => expect(result.current.status?.kind).toBe("error"));
    expect(result.current.dirty).toBe(true);
  });
});
