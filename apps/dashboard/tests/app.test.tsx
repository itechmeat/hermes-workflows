import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
const listItem: WorkflowListItem = {
  id: "deploy",
  name: "Deploy",
  scope: "global",
  trigger: { type: "manual" },
  enabled: true,
  last_run_at: null,
  last_status: null,
  next_run_at: null,
};
const run: RunState = {
  run_id: "deploy-1",
  workflow_id: "deploy",
  workflow_version: 1,
  status: "running",
  nodes: { build: { node_id: "build", status: "running" } },
};

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    o2bStatus: vi.fn(async () => ({ connected: true, installed: true })),
    listWorkflows: vi.fn(async () => [listItem]),
    getWorkflow: vi.fn(async () => detail),
    runWorkflow: vi.fn(async () => ({ run_id: "deploy-1", status: "running" as const })),
    getRun: vi.fn(async () => run),
    listRuns: vi.fn(async () => []), // the editor's mount attach check
    listProfiles: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    ...overrides,
  } as unknown as WorkflowsApi;
}

describe("App shell", () => {
  // View state is mirrored to the URL hash; jsdom keeps the hash between tests,
  // so reset it to start each test on the templates view.
  beforeEach(() => {
    window.location.hash = "";
  });

  it("shows the templates list and the O2B indicator", async () => {
    render(<App client={stubClient()} />);
    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    // The status word is replaced by a colour dot; the full state lives on the
    // indicator's accessible name. The status is set by an async effect, so use
    // a findBy query to avoid racing the fetch/render cycle.
    const indicator = await screen.findByLabelText(/Open Second Brain: connected/i);
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent("O2B");
    // Installed -> links to the host plugins page, same tab.
    expect(indicator).toHaveAttribute("href", "/plugins");
    expect(indicator).not.toHaveAttribute("target");
  });

  it("points the O2B indicator at the repo when O2B is not installed", async () => {
    render(
      <App client={stubClient({ o2bStatus: vi.fn(async () => ({ connected: false, installed: false })) })} />,
    );
    await screen.findByText("Deploy");
    const indicator = await screen.findByLabelText(/Open Second Brain: not connected/i);
    expect(indicator).toHaveAttribute("href", "https://github.com/itechmeat/open-second-brain");
    expect(indicator).toHaveAttribute("target", "_blank");
  });

  it("prefixes the /plugins link with the host base path under a proxy", async () => {
    (window as unknown as { __HERMES_BASE_PATH__?: string }).__HERMES_BASE_PATH__ = "/hermes";
    try {
      render(<App client={stubClient()} />);
      await screen.findByText("Deploy");
      expect(await screen.findByLabelText(/Open Second Brain: connected/i)).toHaveAttribute(
        "href",
        "/hermes/plugins",
      );
    } finally {
      delete (window as unknown as { __HERMES_BASE_PATH__?: string }).__HERMES_BASE_PATH__;
    }
  });

  it("opens a workflow in the editor", async () => {
    render(<App client={stubClient()} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /^actions$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^open$/i }));
    // editor chrome (the Add-node menu) confirms we are in the editor
    expect(await screen.findByRole("button", { name: /add node/i })).toBeInTheDocument();
  });

  it("navigates back to templates from the editor", async () => {
    render(<App client={stubClient()} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /^actions$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^open$/i }));
    await screen.findByRole("button", { name: /add node/i });
    await userEvent.click(screen.getByRole("button", { name: /^workflows$/i }));
    // back on templates: the per-row Actions menu reappears, editor chrome is gone
    expect(await screen.findByRole("button", { name: /^actions$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add node/i })).not.toBeInTheDocument();
  });

  it("creates a new workflow and lands in the editor for the generated id", async () => {
    const createWorkflow = vi.fn(async () => ({ workflow: { id: "x" } as never, path: "" }));
    const getWorkflow = vi.fn(async (_id: string) => detail);
    const client = stubClient({ createWorkflow, getWorkflow });
    render(<App client={client} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /new workflow/i }));
    await userEvent.type(screen.getByLabelText(/^name/i), "Brand New");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(getWorkflow).toHaveBeenCalled());
    const generatedId = getWorkflow.mock.calls[0]![0] as string;
    expect(generatedId).toMatch(/^[a-z]{6}$/);
    expect(await screen.findByRole("button", { name: /add node/i })).toBeInTheDocument();
  });

  it("starts a run from templates and opens the run inspector", async () => {
    const client = stubClient();
    render(<App client={client} />);
    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /^actions$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^run$/i }));
    // the run id surfaces in the header bar's title slot
    expect(await screen.findByText("deploy-1")).toBeInTheDocument();
    expect(client.getRun).toHaveBeenCalledWith("deploy-1");
  });
});
