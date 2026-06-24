import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunsPage } from "../src/pages/RunsPage";
import type { WorkflowsApi } from "../src/api/client";
import type { ExportedRun, RunState, RunSummary } from "../src/api/types";

/** Row actions live behind a per-row "Actions" dropdown: open the row's menu,
 *  then click the named item. */
async function clickRowAction(row: number, name: RegExp): Promise<void> {
  await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[row]!);
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    listRuns: vi.fn(async () => [] as RunSummary[]),
    cancelRun: vi.fn(async () => ({ run_id: "r1", status: "cancelled", nodes: {} }) as RunState),
    retryRun: vi.fn(async () => ({ run_id: "r1", status: "created", nodes: {} }) as RunState),
    exportRunLogs: vi.fn(
      async (id: string): Promise<ExportedRun> => ({
        run_id: id,
        filename: `${id}.run.json`,
        json: { run_id: id, nodes: {} } as RunState,
      }),
    ),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

const runs: RunSummary[] = [
  {
    run_id: "deploy-aaaa1111",
    workflow_id: "deploy",
    project_id: "acme",
    status: "running",
    current_node: "build",
    started_at: 1_700_000_000,
    finished_at: null,
    duration: null,
    total_tokens: null,
  },
  {
    run_id: "nightly-bbbb2222",
    workflow_id: "nightly",
    project_id: null,
    status: "completed",
    current_node: "done",
    started_at: 1_700_000_000,
    finished_at: 1_700_000_042,
    duration: 42,
    total_tokens: 25_000,
  },
];

afterEach(() => vi.restoreAllMocks());

describe("RunsPage", () => {
  it("renders a row per run with the page columns", async () => {
    const client = stubClient({ listRuns: vi.fn(async () => runs) });
    render(<RunsPage client={client} onOpenRun={() => {}} />);

    expect(await screen.findByText("deploy-aaaa1111")).toBeInTheDocument();
    expect(screen.getByText("nightly-bbbb2222")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument(); // current node
    expect(screen.getByText("acme")).toBeInTheDocument(); // project
    expect(screen.getByText("25,000")).toBeInTheDocument(); // token total
  });

  it("loads all runs by default", async () => {
    const listRuns = vi.fn(async () => runs);
    render(<RunsPage client={stubClient({ listRuns })} onOpenRun={() => {}} />);
    await screen.findByText("deploy-aaaa1111");
    expect(listRuns).toHaveBeenCalledWith("all");
  });

  it("re-fetches active-only when the filter is toggled", async () => {
    const listRuns = vi.fn(async () => runs);
    render(<RunsPage client={stubClient({ listRuns })} onOpenRun={() => {}} />);
    await screen.findByText("deploy-aaaa1111");
    await userEvent.click(screen.getByLabelText(/active only/i));
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith("active"));
  });

  it("shows an empty state when there are no runs", async () => {
    render(<RunsPage client={stubClient()} onOpenRun={() => {}} />);
    expect(await screen.findByText(/no runs/i)).toBeInTheDocument();
  });

  it("opens the inspector when Open is clicked", async () => {
    const onOpenRun = vi.fn();
    const client = stubClient({ listRuns: vi.fn(async () => runs) });
    render(<RunsPage client={client} onOpenRun={onOpenRun} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /open/i);
    expect(onOpenRun).toHaveBeenCalledWith("deploy-aaaa1111");
  });

  it("links the Run ID to the inspector and the Workflow to its editor", async () => {
    const onOpenRun = vi.fn();
    const onOpenWorkflow = vi.fn();
    const client = stubClient({ listRuns: vi.fn(async () => runs) });
    render(
      <RunsPage client={client} onOpenRun={onOpenRun} onOpenWorkflow={onOpenWorkflow} />,
    );
    await screen.findByText("deploy-aaaa1111");

    await userEvent.click(screen.getByRole("link", { name: "deploy-aaaa1111" }));
    expect(onOpenRun).toHaveBeenCalledWith("deploy-aaaa1111");

    await userEvent.click(screen.getByRole("link", { name: "deploy" }));
    expect(onOpenWorkflow).toHaveBeenCalledWith("deploy");
  });

  it("falls back to an #editor href for the Workflow link when no callback is wired", async () => {
    const client = stubClient({ listRuns: vi.fn(async () => runs) });
    render(<RunsPage client={client} onOpenRun={() => {}} />);
    await screen.findByText("deploy-aaaa1111");
    expect(screen.getByRole("link", { name: "deploy" })).toHaveAttribute(
      "href",
      "#editor/deploy",
    );
  });

  it("cancels a run and refreshes", async () => {
    const cancelRun = vi.fn(async () => ({ run_id: "deploy-aaaa1111", status: "cancelled", nodes: {} }) as RunState);
    const listRuns = vi.fn(async () => runs);
    render(<RunsPage client={stubClient({ listRuns, cancelRun })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /cancel/i);
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("deploy-aaaa1111"));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
  });

  it("retries a whole run", async () => {
    const retryRun = vi.fn(async () => ({ run_id: "deploy-aaaa1111", status: "created", nodes: {} }) as RunState);
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => runs), retryRun })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /retry run/i);
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith("deploy-aaaa1111"));
  });

  it("retries a single node, prompting for its id", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("build");
    const retryRun = vi.fn(async () => ({ run_id: "deploy-aaaa1111", status: "created", nodes: {} }) as RunState);
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => runs), retryRun })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /retry node/i);
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith("deploy-aaaa1111", "build"));
  });

  it("offers Resume only on failed/cancelled runs, naming the failed node", async () => {
    const failedRuns: RunSummary[] = [
      { ...runs[0]!, run_id: "deploy-failed", status: "failed", current_node: "build" },
      { ...runs[1]!, run_id: "nightly-cancelled", status: "cancelled", current_node: null },
    ];
    const retryRun = vi.fn(async () => ({ run_id: "deploy-failed", status: "running", nodes: {} }) as RunState);
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => failedRuns), retryRun })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-failed");
    // A failed run resumes FROM its failed node.
    await clickRowAction(0, /resume from build/i);
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith("deploy-failed", "build"));
  });

  it("resumes a cancelled run by restarting (no failed node)", async () => {
    const cancelled: RunSummary[] = [
      { ...runs[0]!, run_id: "deploy-cancelled", status: "cancelled", current_node: null },
    ];
    const retryRun = vi.fn(async () => ({ run_id: "deploy-cancelled", status: "created", nodes: {} }) as RunState);
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => cancelled), retryRun })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-cancelled");
    await clickRowAction(0, /resume \(restart\)/i);
    await waitFor(() => expect(retryRun).toHaveBeenCalledWith("deploy-cancelled", undefined));
  });

  it("does not offer Resume on an active run", async () => {
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => runs) })} onOpenRun={() => {}} />);
    await screen.findByText("deploy-aaaa1111");
    // deploy-aaaa1111 is running -> open its menu, no Resume item.
    await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[0]!);
    expect(screen.queryByRole("menuitem", { name: /resume/i })).not.toBeInTheDocument();
  });

  it("exports a run's logs as a download", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const exportRunLogs = vi.fn(
      async (id: string): Promise<ExportedRun> => ({
        run_id: id,
        filename: `${id}.run.json`,
        json: { run_id: id, nodes: {} } as RunState,
      }),
    );
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => runs), exportRunLogs })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /export/i);
    await waitFor(() => expect(exportRunLogs).toHaveBeenCalledWith("deploy-aaaa1111"));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("downloads the trace as a second file when the export carries one", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const exportRunLogs = vi.fn(
      async (id: string): Promise<ExportedRun> => ({
        run_id: id,
        filename: `${id}.run.json`,
        json: { run_id: id, nodes: {} } as RunState,
        trace_filename: `${id}.trace.jsonl`,
        trace: '{"ts":1,"kind":"run_created"}\n',
      }),
    );
    render(<RunsPage client={stubClient({ listRuns: vi.fn(async () => runs), exportRunLogs })} onOpenRun={() => {}} />);

    await screen.findByText("deploy-aaaa1111");
    await clickRowAction(0, /export/i);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
  });

  it("surfaces a load error", async () => {
    const client = stubClient({
      listRuns: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<RunsPage client={client} onOpenRun={() => {}} />);
    expect(await screen.findByText(/Could not load runs/i)).toBeInTheDocument();
    expect(screen.getByText(/the request for runs failed/i)).toBeInTheDocument();
  });
});
