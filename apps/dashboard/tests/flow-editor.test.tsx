import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowEditor } from "../src/editor/FlowEditor";
import type { WorkflowsApi } from "../src/api/client";
import type { SpecDetail, Workflow, UiLayout } from "../src/api/types";

const workflow: Workflow = {
  id: "deploy",
  name: "Deploy Pipeline",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  nodes: [
    { id: "build", type: "agent_task", prompt: "build", profile: "devops-engineer" },
    { id: "done", type: "finish", outcome: "success" },
  ],
  edges: [{ from: "build", to: "done" }],
};

const ui: UiLayout = {
  xyflow: {
    nodes: [
      { id: "build", x: 0, y: 0 },
      { id: "done", x: 200, y: 40 },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
};

const detail: SpecDetail = { workflow, ui, path: "/x/deploy.workflow.yaml" };

function stubClient(): WorkflowsApi {
  return {
    saveWorkflow: vi.fn(async (_id, body) => ({ ...body, path: detail.path })),
    listProfiles: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
  } as unknown as WorkflowsApi;
}

function failingClient(message: string): WorkflowsApi {
  return {
    saveWorkflow: vi.fn(async () => {
      throw new Error(message);
    }),
    listProfiles: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
  } as unknown as WorkflowsApi;
}

describe("FlowEditor", () => {
  it("shows a back button only when onBack is provided, and fires it", async () => {
    const { rerender } = render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();

    const onBack = vi.fn();
    rerender(<FlowEditor detail={detail} client={stubClient()} onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders a node per workflow node at its ui position", () => {
    const { container } = render(<FlowEditor detail={detail} client={stubClient()} />);

    // Both nodes render with their ids as labels.
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();

    // xyflow tags each node wrapper with its id and positions it by transform.
    const buildNode = container.querySelector('[data-id="build"]') as HTMLElement | null;
    const doneNode = container.querySelector('[data-id="done"]') as HTMLElement | null;
    expect(buildNode).not.toBeNull();
    expect(doneNode?.style.transform).toContain("200px");
  });

  it("starts clean with Save disabled", () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    // A disabled Save button is the only "no changes" signal now; the header
    // carries no status text.
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("stays clean on mount even when the spec has no saved viewport (fitView)", () => {
    // No viewport -> fitView runs and fires onMoveEnd; that must not dirty the
    // untouched graph.
    const noViewport: SpecDetail = {
      ...detail,
      ui: { xyflow: { nodes: ui.xyflow!.nodes } },
    };
    render(<FlowEditor detail={noViewport} client={stubClient()} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("renders the workflow name in the toolbar", () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
  });

  it("adds a node from the Add-node menu, opening it for editing and marking dirty", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);

    await userEvent.click(screen.getByRole("button", { name: /add node/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Agent task" }));

    // a freshly added node opens straight into the editor modal
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    // and the graph is now dirty, enabling Save
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });

  it("re-lays-out the graph when Auto-layout is clicked", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /auto-layout/i }));
    // applying a layout is an edit -> the graph is dirty and Save is enabled
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });

  it("disables Duplicate until a node is selected", () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.getByRole("button", { name: /duplicate node/i })).toBeDisabled();
  });

  it("duplicates the selected node onto the canvas", async () => {
    const { container } = render(<FlowEditor detail={detail} client={stubClient()} />);

    // adding a node auto-selects it; duplicate then clones the selection
    await userEvent.click(screen.getByRole("button", { name: /add node/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Agent task" }));
    await userEvent.click(screen.getByRole("button", { name: /duplicate node/i }));

    // node ids are sequential numbers: the added node is "1", its clone "2"
    expect(container.querySelector('[data-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-id="2"]')).not.toBeNull();
  });

  // The node modal opens on double-click (onNodeDoubleClick) and selection on
  // single click (onNodeClick). These ReactFlow pointer paths can't be driven
  // in jsdom — d3-drag dereferences a live `document` on mousedown and throws —
  // so the editor-open path is covered above via the Add-node menu instead.

  it("pops a toast with the human-readable reason when a save fails validation", async () => {
    const message =
      "incomplete_branch: node 'build' branches on node_status but covers neither outcome";
    const { container } = render(<FlowEditor detail={detail} client={failingClient(message)} />);
    // Auto-layout dirties the graph (no node modal in the way), enabling Save.
    await userEvent.click(screen.getByRole("button", { name: /auto-layout/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    // The prominent toast (not just the inline bar label) carries the reason.
    const toast = await screen.findByTestId("save-error-toast");
    expect(toast).toHaveTextContent(/incomplete_branch/i);
    expect(toast).toHaveTextContent("node 'build' branches on node_status");
    expect(container.querySelector(".hw-toast")).not.toBeNull();
  });

  it("shows no toast when a save succeeds", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    await userEvent.click(screen.getByRole("button", { name: /auto-layout/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    // A successful save clears dirty, re-disabling the Save button; the header
    // carries no status text now, so the button state is the settle signal.
    await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled());
    expect(screen.queryByTestId("save-error-toast")).not.toBeInTheDocument();
  });
});
