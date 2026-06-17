import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowEditor } from "../src/editor/FlowEditor";
import type { WorkflowsApi } from "../src/api/client";
import type { RunState, RunSummary, SpecDetail, Workflow, UiLayout } from "../src/api/types";

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

/** An active-run summary as the attach lookup returns it. */
function runSummary(status: RunSummary["status"], runId = RUN_ID): RunSummary {
  return {
    run_id: runId,
    workflow_id: "deploy",
    project_id: null,
    status,
    current_node: "build",
    started_at: 1000,
    finished_at: null,
    duration: null,
    total_tokens: null,
  };
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  return {
    saveWorkflow: vi.fn(async (_id: string, body: object) => ({ ...body, path: detail.path })),
    listProfiles: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    // The attach lookup: no active run by default.
    listRuns: vi.fn(async () => [] as RunSummary[]),
    runWorkflow: vi.fn(async () => ({ run_id: RUN_ID, status: "running" })),
    getRun: vi.fn(async () => runState("running")),
    ...overrides,
  } as unknown as WorkflowsApi;
}

// The Play button's visible label tracks the phase (Play / Starting… / Running…).
const playButton = (): HTMLElement =>
  screen.getByRole("button", { name: /^(play|starting…|running…)$/i });

/** Click Play once the mount attach check has released it. */
async function clickPlay(): Promise<void> {
  await waitFor(() => expect(playButton()).toBeEnabled());
  await userEvent.click(playButton());
}

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

    await clickPlay();

    expect(client.runWorkflow).toHaveBeenCalledWith("deploy");
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());
    expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
  });

  it("locks editing actions while the run plays", async () => {
    render(<FlowEditor detail={detail} client={stubClient()} onOpenRun={vi.fn()} pollMs={10_000} />);

    await clickPlay();

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

    await clickPlay();

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

    await clickPlay();

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

    await clickPlay();

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
    await clickPlay();

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
    await clickPlay();

    const toast = await screen.findByTestId("save-error-toast");
    expect(toast.textContent).toMatch(/disk full/i);
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

    await clickPlay();

    const toast = await screen.findByTestId("playback-error-toast");
    expect(toast.textContent).toMatch(/workflow is disabled/i);
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

    await clickPlay();

    const toast = await screen.findByTestId("playback-error-toast");
    expect(toast.textContent).toMatch(/network down/i);
    // The next successful poll clears the error instead of killing playback.
    await waitFor(() => expect(screen.queryByTestId("playback-error-toast")).not.toBeInTheDocument(), {
      timeout: 1000,
    });
  });

  it("attaches to an already-active run on mount, locking the editor", async () => {
    const listRuns = vi.fn(async () => [runSummary("running")]);
    const { container } = render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    // No Play click: the mount check finds the active run and enters playback.
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith("active", "deploy"));
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());
    expect(playButton()).toBeDisabled();
    expect(playButton().textContent).toMatch(/running…/i);
    expect(screen.getByRole("button", { name: /add node/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("opens a node read-only while the run plays", async () => {
    const listRuns = vi.fn(async () => [runSummary("running")]);
    const { container } = render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    // The mount attach check enters playback and renders the run nodes.
    await waitFor(() => expect(container.querySelector('[data-status="running"]')).not.toBeNull());

    // Open a node mid-run via its open affordance. Double-click drives the same
    // openNode path, but ReactFlow's pointer gesture is undrivable in jsdom
    // (d3-drag throws on mousedown), so the button stands in for it here. The
    // button sits in an unmeasured (hidden) node subtree, so it is queried by
    // aria-label and clicked with fireEvent (role queries skip hidden nodes).
    const openBtn = await waitFor(() => {
      const el = document.querySelector('[aria-label="Open node build"]');
      if (el === null) throw new Error("open button not rendered yet");
      return el as HTMLElement;
    });
    fireEvent.click(openBtn);

    // The inspector opens fully disabled: a disabled <fieldset> renders every
    // control read-only, so the live run can never be edited from here.
    const promptField = await screen.findByLabelText("Prompt");
    expect(promptField).toBeDisabled();
  });

  it("hands off to the inspector when the active run found on mount settles", async () => {
    const onOpenRun = vi.fn();
    const listRuns = vi.fn(async () => [runSummary("running")]);
    const getRun = vi.fn(async () => runState("completed"));
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns, getRun })}
        onOpenRun={onOpenRun}
        pollMs={20}
      />,
    );

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(RUN_ID));
  });

  it("hands off immediately when the run found on mount is parked in waiting", async () => {
    const onOpenRun = vi.fn();
    const listRuns = vi.fn(async () => [runSummary("waiting")]);
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns })}
        onOpenRun={onOpenRun}
        pollMs={10_000}
      />,
    );

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith(RUN_ID));
  });

  it("stays idle when the mount check finds no active run", async () => {
    const client = stubClient();
    render(<FlowEditor detail={detail} client={client} onOpenRun={vi.fn()} pollMs={10_000} />);

    await waitFor(() => expect(playButton()).toBeEnabled());
    expect(playButton().textContent).toMatch(/^play$/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps Play disabled while the mount check is pending", () => {
    const listRuns = vi.fn(() => new Promise<never>(() => {})); // never settles
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns: listRuns as unknown as WorkflowsApi["listRuns"] })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    expect(playButton()).toBeDisabled();
  });

  it("surfaces a failed mount check as a visible error and unlocks Play", async () => {
    const listRuns = vi.fn(async () => {
      throw new Error("runs store unreachable");
    });
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ listRuns })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    const toast = await screen.findByTestId("playback-error-toast");
    expect(toast.textContent).toMatch(/active-run check failed/i);
    expect(toast.textContent).toMatch(/runs store unreachable/i);
    expect(playButton()).toBeEnabled();
  });

  it("attaches to the concurrent run after a refused start, keeping the error visible", async () => {
    // Single-flight race: another surface started a run between the mount
    // check and the Play click — the start 409s, the editor shows the refusal
    // AND adopts the real state.
    const runWorkflow = vi.fn(async () => {
      throw new Error("workflow 'deploy' already has an active run 'deploy-1'");
    });
    const listRuns = vi
      .fn(async () => [] as RunSummary[]) // mount: idle
      .mockResolvedValueOnce([] as RunSummary[])
      .mockResolvedValue([runSummary("running")]); // re-check after the refusal
    render(
      <FlowEditor
        detail={detail}
        client={stubClient({ runWorkflow, listRuns })}
        onOpenRun={vi.fn()}
        pollMs={10_000}
      />,
    );

    await clickPlay();

    const toast = await screen.findByTestId("playback-error-toast");
    expect(toast.textContent).toMatch(/already has an active run/i);
    await waitFor(() => expect(playButton().textContent).toMatch(/running…/i));
    expect(playButton()).toBeDisabled();
  });

  it("returns to idle after a refused start when nothing is active", async () => {
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

    await clickPlay();

    await screen.findByRole("alert");
    await waitFor(() => expect(playButton()).toBeEnabled());
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

    await clickPlay();

    await waitFor(() => expect(playButton()).toBeDisabled());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });
});
