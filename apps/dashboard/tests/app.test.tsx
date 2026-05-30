import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import type { WorkflowsApi } from "../src/api/client";
import type { RunState, SpecDetail, Workflow, UiLayout, WorkflowListItem } from "../src/api/types";

const workflow: Workflow = {
  id: "deploy",
  name: "Deploy",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  nodes: [{ id: "build", type: "agent_task", prompt: "x", profile: "dev" }],
  edges: [],
};
const ui: UiLayout = { xyflow: { nodes: [{ id: "build", x: 0, y: 0 }] } };
const detail: SpecDetail = { workflow, ui, path: "/x/deploy.workflow.yaml" };
const listItem: WorkflowListItem = { id: "deploy", name: "Deploy", scope: "global", trigger: { type: "manual" } };
const run: RunState = {
  run_id: "deploy-1",
  workflow_id: "deploy",
  workflow_version: 1,
  status: "running",
  nodes: { build: { node_id: "build", status: "running" } },
};

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    o2bStatus: vi.fn(async () => ({ connected: true })),
    listWorkflows: vi.fn(async () => [listItem]),
    getWorkflow: vi.fn(async () => detail),
    runWorkflow: vi.fn(async () => ({ run_id: "deploy-1", status: "running" as const })),
    getRun: vi.fn(async () => run),
    ...overrides,
  } as unknown as WorkflowsApi;
}

describe("App shell", () => {
  it("shows the templates list and the O2B badge", async () => {
    render(<App client={stubClient()} />);
    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText(/OpenSecondBrain: connected/i)).toBeInTheDocument();
  });

  it("opens a workflow in the editor", async () => {
    render(<App client={stubClient()} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(await screen.findByText(/Editing deploy/i)).toBeInTheDocument();
  });

  it("navigates back to templates from the editor", async () => {
    render(<App client={stubClient()} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /open/i }));
    await screen.findByText(/Editing deploy/i);
    await userEvent.click(screen.getByRole("button", { name: /^workflows$/i }));
    // back on templates: the per-row Open button reappears, editor chrome is gone
    expect(await screen.findByRole("button", { name: /open/i })).toBeInTheDocument();
    expect(screen.queryByText(/Editing deploy/i)).not.toBeInTheDocument();
  });

  it("starts a run from templates and opens the run inspector", async () => {
    const client = stubClient();
    render(<App client={client} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(await screen.findByText(/Run deploy-1/i)).toBeInTheDocument();
    expect(client.getRun).toHaveBeenCalledWith("deploy-1");
  });
});
