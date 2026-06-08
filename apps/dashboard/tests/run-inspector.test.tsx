import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunInspector } from "../src/run/RunInspector";
import type { WorkflowsApi } from "../src/api/client";
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
const ui: UiLayout = { xyflow: { nodes: [{ id: "build", x: 0, y: 0 }, { id: "done", x: 200, y: 0 }] } };
const detail: SpecDetail = { workflow, ui, path: "/x/deploy.workflow.yaml" };

function runState(status: RunState["status"]): RunState {
  return {
    run_id: "deploy-1",
    workflow_id: "deploy",
    workflow_version: 1,
    status,
    nodes: {
      build: { node_id: "build", status: "running", output: "building now" },
      done: { node_id: "done", status: "pending" },
    },
  };
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    getRun: vi.fn(async () => runState("running")),
    getWorkflow: vi.fn(async () => detail),
    cancelRun: vi.fn(async () => runState("cancelled")),
    retryRun: vi.fn(async () => runState("running")),
    ...overrides,
  } as unknown as WorkflowsApi;
}

// Open the "build" node's detail modal. ReactFlow leaves unmeasured nodes in an
// inaccessible (hidden) subtree under jsdom, so the open button is queried by
// its aria-label and clicked with fireEvent (userEvent / getByRole skip hidden
// elements). In a real browser the node is visible and clickable.
async function openBuildNode(): Promise<void> {
  const btn = await waitFor(() => {
    const el = document.querySelector('[aria-label="Open node build"]');
    if (el === null) throw new Error("open button not rendered yet");
    return el as HTMLElement;
  });
  fireEvent.click(btn);
}

describe("RunInspector", () => {
  it("renders nodes coloured by their run status", async () => {
    const { container } = render(<RunInspector runId="deploy-1" client={stubClient()} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
  });

  it("keeps the node's profile·model info line and shows the run status on its own line", async () => {
    const { container } = render(
      <RunInspector runId="deploy-1" client={stubClient()} pollMs={10_000} />,
    );
    await screen.findByText("deploy-1");
    const card = await waitFor(() => {
      const el = container.querySelector('.hw-node--run[data-status="running"]');
      if (el === null) throw new Error("node not rendered yet");
      return el as HTMLElement;
    });
    // The info line (profile · model) is preserved — not overwritten by status…
    expect(card.querySelector(".hw-node__meta")?.textContent).toContain("dev");
    // …and the run status sits on its own dedicated line.
    expect(card.querySelector(".hw-node__status")?.textContent).toContain("running");
  });

  it("cancels the run", async () => {
    const cancelRun = vi.fn(async () => runState("cancelled"));
    render(<RunInspector runId="deploy-1" client={stubClient({ cancelRun })} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(cancelRun).toHaveBeenCalledWith("deploy-1");
  });

  it("retries the whole run with no node id", async () => {
    const retryRun = vi.fn(async () => runState("running"));
    render(<RunInspector runId="deploy-1" client={stubClient({ retryRun })} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await userEvent.click(screen.getByRole("button", { name: /retry run/i }));
    expect(retryRun).toHaveBeenCalledWith("deploy-1", undefined);
  });

  it("retries a single node after selecting it", async () => {
    const retryRun = vi.fn(async () => runState("running"));
    render(<RunInspector runId="deploy-1" client={stubClient({ retryRun })} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await openBuildNode();
    await userEvent.click(screen.getByRole("button", { name: /retry node/i }));
    expect(retryRun).toHaveBeenCalledWith("deploy-1", "build");
  });

  it("shows the telemetry block for a node that has it", async () => {
    const state = runState("running");
    state.nodes["build"]!.telemetry = {
      duration_ms: 65_000,
      input_tokens: 17,
      output_tokens: 8,
      total_tokens: 25,
      api_calls: 2,
      tool_calls: 3,
      tool_errors: 1,
      subagents: 1,
      error_type: "ToolError",
      error_message: "exit 1",
    };
    const getRun = vi.fn(async () => state);
    render(<RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await openBuildNode();

    expect(screen.getByText(/agent telemetry/i)).toBeInTheDocument();
    expect(screen.getByText("1m 5s")).toBeInTheDocument(); // duration
    expect(screen.getByText("25 (17 in / 8 out)")).toBeInTheDocument(); // tokens
    expect(screen.getByText("2")).toBeInTheDocument(); // API calls
    expect(screen.getByText("3 (1 failed)")).toBeInTheDocument(); // tool calls
    expect(screen.getByText("ToolError: exit 1")).toBeInTheDocument();
  });

  it("surfaces a pending command approval on an active node", async () => {
    const state = runState("running");
    state.nodes["build"]!.telemetry = {
      tool_calls: 1,
      approval: {
        state: "pending",
        command: "rm -rf /tmp/x",
        description: "Delete files",
        requested_at: 100,
      },
    };
    const getRun = vi.fn(async () => state);
    const { container } = render(
      <RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={10_000} />,
    );
    await screen.findByText("deploy-1");
    // The node card carries the waiting badge.
    await waitFor(() =>
      expect(container.querySelector('[data-approval="pending"]')).not.toBeNull(),
    );
    // The node detail names the command awaiting approval.
    await openBuildNode();
    expect(screen.getByText(/waiting for command approval/i)).toBeInTheDocument();
    expect(screen.getByText("rm -rf /tmp/x")).toBeInTheDocument();
  });

  it("clears the pending annotation once the approval resolves", async () => {
    const state = runState("running");
    state.nodes["build"]!.telemetry = {
      approval: { state: "resolved", command: "rm -rf /tmp/x", choice: "once" },
    };
    const { container } = render(
      <RunInspector runId="deploy-1" client={stubClient({ getRun: vi.fn(async () => state) })} pollMs={10_000} />,
    );
    await screen.findByText("deploy-1");
    expect(container.querySelector('[data-approval="pending"]')).toBeNull();
    await openBuildNode();
    expect(screen.queryByText(/waiting for command approval/i)).toBeNull();
    // An uneventful resolution (once/session/always) leaves no note either.
    expect(screen.queryByText(/rm -rf/)).toBeNull();
  });

  it("keeps deny visible on a settled node for failure context", async () => {
    const state = runState("running");
    state.nodes["build"] = {
      node_id: "build",
      status: "failed",
      outcome: "failure",
      telemetry: {
        approval: { state: "resolved", command: "rm -rf /tmp/x", choice: "deny" },
      },
    };
    render(
      <RunInspector runId="deploy-1" client={stubClient({ getRun: vi.fn(async () => state) })} pollMs={10_000} />,
    );
    await screen.findByText("deploy-1");
    await openBuildNode();
    expect(screen.getByText(/command approval denied/i)).toBeInTheDocument();
    expect(screen.getByText("rm -rf /tmp/x")).toBeInTheDocument();
  });

  it("renders no telemetry block when a node has none", async () => {
    render(<RunInspector runId="deploy-1" client={stubClient()} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await openBuildNode();
    expect(screen.queryByText(/agent telemetry/i)).toBeNull();
  });

  it("stops polling once the run is terminal", async () => {
    const getRun = vi.fn(async () => runState("completed"));
    render(<RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={20} />);
    await screen.findByText("completed");
    const callsAfterLoad = getRun.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getRun.mock.calls.length).toBe(callsAfterLoad);
    expect(callsAfterLoad).toBe(1);
  });

  it("keeps polling while the run is active", async () => {
    const getRun = vi.fn(async () => runState("running"));
    const { unmount } = render(<RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={20} />);
    await screen.findByText("deploy-1");
    await waitFor(() => expect(getRun.mock.calls.length).toBeGreaterThan(1), { timeout: 1000 });
    unmount();
  });

  it("surfaces a poll failure inline once the run is loaded, and recovers", async () => {
    let polls = 0;
    const getRun = vi.fn(async () => {
      polls += 1;
      if (polls === 2) throw new Error("network down");
      return runState("running");
    });
    render(<RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={20} />);
    // The run stays on screen while the failed poll reports next to the title…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/network down/i);
    expect(screen.getByText("deploy-1")).toBeInTheDocument();
    // …and the next successful poll clears it.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument(), {
      timeout: 1000,
    });
  });

  it("shows an explicit page error when the run never loads", async () => {
    const getRun = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<RunInspector runId="deploy-1" client={stubClient({ getRun })} pollMs={10_000} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/failed to load run: boom/i);
  });
});
