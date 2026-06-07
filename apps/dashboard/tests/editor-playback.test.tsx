import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowEditor } from "../src/editor/FlowEditor";
import type { WorkflowsApi } from "../src/api/client";
import type { RunState, SpecDetail, Workflow, UiLayout } from "../src/api/types";

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

const RUN_ID = "deploy-1";

function runState(status: RunState["status"]): RunState {
  return {
    run_id: RUN_ID,
    workflow_id: "deploy",
    workflow_version: 1,
    status,
    nodes: {
      build: { node_id: "build", status: status === "completed" ? "completed" : "running" },
      done: { node_id: "done", status: status === "completed" ? "completed" : "pending" },
    },
  };
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    saveWorkflow: vi.fn(async (_id: string, body: object) => ({ ...body, path: detail.path })),
    listProfiles: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    runWorkflow: vi.fn(async () => ({ run_id: RUN_ID, status: "running" })),
    getRun: vi.fn(async () => runState("running")),
    ...overrides,
  } as unknown as WorkflowsApi;
}

// The Play button's visible label tracks the phase (Play / Starting… / Running…).
const playButton = (): HTMLElement =>
  screen.getByRole("button", { name: /^(play|starting…|running…)$/i });

describe("FlowEditor playback", () => {
  it("renders Play only when the run-inspector navigation is wired", () => {
    const { rerender } = render(<FlowEditor detail={detail} client={stubClient()} />);
    expect(screen.queryByRole("button", { name: /play/i })).not.toBeInTheDocument();

    rerender(<FlowEditor detail={detail} client={stubClient()} onOpenRun={vi.fn()} />);
    expect(playButton()).toBeInTheDocument();
  });

  it("starts the run and overlays live node status on the canvas", async () => {
    const client = stubClient();
    const { container } = render(
      <FlowEditor detail={detail} client={client} onOpenRun={vi.fn()} pollMs={10_000} />,
    );

    await userEvent.click(playButton());

    expect(client.runWorkflow).toHaveBeenCalledWith("deploy");
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
  });

  it("locks editing actions while the run plays", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} onOpenRun={vi.fn()} pollMs={10_000} />);

    await userEvent.click(playButton());

    await waitFor(() => expect(playButton()).toBeDisabled());
    expect(screen.getByRole("button", { name: /add node/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /duplicate node/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /auto-layout/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /tools/i })).toBeDisabled();
  });

  it("redirects to the run inspector once the run reaches a terminal status", async () => {
    const onOpenRun = vi.fn();
    const getRun = vi.fn(async () => runState("completed"));
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ getRun })}
        onOpenRun={onOpenRun}
        pollMs={20}
      />,
    );

    await userEvent.click(playButton());

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(RUN_ID));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
  });

  it("redirects to the run inspector when the run parks in waiting (human review)", async () => {
    const onOpenRun = vi.fn();
    const getRun = vi.fn(async () => runState("waiting"));
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ getRun })}
        onOpenRun={onOpenRun}
        pollMs={20}
      />,
    );

    await userEvent.click(playButton());

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(RUN_ID));
  });

  it("redirects without polling when the start response is already settled", async () => {
    const onOpenRun = vi.fn();
    const getRun = vi.fn(async () => runState("completed"));
    const runWorkflow = vi.fn(async () => ({ run_id: RUN_ID, status: "completed" as const }));
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ getRun, runWorkflow })}
        onOpenRun={onOpenRun}
        pollMs={20}
      />,
    );

    await userEvent.click(playButton());

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(RUN_ID));
    expect(getRun).not.toHaveBeenCalled();
  });

  it("saves a dirty editor before starting the run", async () => {
    const calls: string[] = [];
    const saveWorkflow = vi.fn(async (_id: string, body: object) => {
      calls.push("save");
      return { ...body, path: detail.path } as SpecDetail;
    });
    const runWorkflow = vi.fn(async () => {
      calls.push("run");
      return { run_id: RUN_ID, status: "running" as const };
    });
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ saveWorkflow, runWorkflow })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    // Auto-layout marks the graph dirty without needing canvas gestures.
    await userEvent.click(screen.getByRole("button", { name: /auto-layout/i }));
    await userEvent.click(playButton());

    await waitFor(() => expect(runWorkflow).toHaveBeenCalled());
    expect(calls).toEqual(["save", "run"]);
  });

  it("does not start the run when the pre-play save fails", async () => {
    const saveWorkflow = vi.fn(async () => {
      throw new Error("disk full");
    });
    const runWorkflow = vi.fn(async () => ({ run_id: RUN_ID, status: "running" as const }));
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ saveWorkflow, runWorkflow })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /auto-layout/i }));
    await userEvent.click(playButton());

    await screen.findByText(/save failed: disk full/i);
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(playButton()).toBeEnabled();
  });

  it("shows an explicit error when the start is rejected", async () => {
    const runWorkflow = vi.fn(async () => {
      throw new Error("workflow is disabled");
    });
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ runWorkflow })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    await userEvent.click(playButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/workflow is disabled/i);
    // The editor returns to idle so the operator can fix the cause and retry.
    expect(playButton()).toBeEnabled();
  });

  it("surfaces a poll failure while the run keeps playing", async () => {
    let polls = 0;
    const getRun = vi.fn(async () => {
      polls += 1;
      if (polls === 1) throw new Error("network down");
      return runState("running");
    });
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ getRun })}
        onOpenRun={vi.fn()}
        pollMs={20}
      />,
    );

    await userEvent.click(playButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/network down/i);
    // The next successful poll clears the error instead of killing playback.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument(), {
      timeout: 1000,
    });
  });

  it("prevents a double start while the run is starting", async () => {
    const runWorkflow = vi.fn(
      () => new Promise<never>(() => {}), // never settles: stuck in "starting"
    );
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ runWorkflow: runWorkflow as unknown as WorkflowsApi["runWorkflow"] })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    await userEvent.click(playButton());

    await waitFor(() => expect(playButton()).toBeDisabled());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });
});
