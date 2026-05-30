import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TemplatesPage } from "../src/pages/TemplatesPage";
import type { WorkflowsApi } from "../src/api/client";
import type { WorkflowListItem } from "../src/api/types";

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    listWorkflows: vi.fn(async () => [] as WorkflowListItem[]),
    runWorkflow: vi.fn(async () => ({ run_id: "wf-1-abc", status: "running" as const })),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

const items: WorkflowListItem[] = [
  { id: "deploy", name: "Deploy", scope: "global", trigger: { type: "manual" } },
  {
    id: "nightly",
    name: "Nightly",
    scope: "project",
    trigger: { type: "cron", schedule: "0 5 * * *" },
  },
];

describe("TemplatesPage", () => {
  it("renders a row per workflow with id, name, scope, and trigger", async () => {
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.getByText("global")).toBeInTheDocument();
    // cron trigger surfaces its schedule
    expect(screen.getByText(/0 5 \* \* \*/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no workflows", async () => {
    const client = stubClient();
    render(<TemplatesPage client={client} onOpen={() => {}} />);
    expect(await screen.findByText(/no workflows/i)).toBeInTheDocument();
  });

  it("opens a workflow in the editor when Open is clicked", async () => {
    const onOpen = vi.fn();
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={onOpen} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getAllByRole("button", { name: /open/i })[0]!);

    expect(onOpen).toHaveBeenCalledWith("deploy");
  });

  it("starts a run and reports the new run id when Run is clicked", async () => {
    const runWorkflow = vi.fn(async () => ({ run_id: "deploy-12345678", status: "running" as const }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), runWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getAllByRole("button", { name: /^run$/i })[0]!);

    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith("deploy"));
    expect(await screen.findByText(/deploy-12345678/)).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    const client = stubClient({
      listWorkflows: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<TemplatesPage client={client} onOpen={() => {}} />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });
});
