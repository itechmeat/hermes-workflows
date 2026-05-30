import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("RunInspector", () => {
  it("renders nodes coloured by their run status", async () => {
    const { container } = render(<RunInspector runId="deploy-1" client={stubClient()} pollMs={10_000} />);
    await screen.findByText("deploy-1");
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: /build — running/i }));
    await userEvent.click(screen.getByRole("button", { name: /retry node/i }));
    expect(retryRun).toHaveBeenCalledWith("deploy-1", "build");
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
});
