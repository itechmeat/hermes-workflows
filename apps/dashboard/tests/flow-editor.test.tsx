import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  } as unknown as WorkflowsApi;
}

describe("FlowEditor", () => {
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
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
  });

  it("renders the workflow name in the toolbar", () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
  });

  it("adds a node from the palette, selecting it for editing and marking dirty", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} />);

    await userEvent.click(screen.getByRole("button", { name: "Agent task" }));

    // newly added node is auto-selected -> inspector shows agent_task fields
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    // and the graph is now dirty, enabling Save
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });
});
