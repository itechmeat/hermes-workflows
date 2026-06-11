import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewWorkflowModal } from "../src/templates/NewWorkflowModal";
import type { WorkflowsApi } from "../src/api/client";
import type { CreateWorkflowBody, SpecDetail } from "../src/api/types";

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    createWorkflow: vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "x" } as never,
        path: "/x.yaml",
      }),
    ),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

describe("NewWorkflowModal", () => {
  it("renders name, scope, and trigger fields — but no id field (it is generated)", () => {
    render(<NewWorkflowModal onCreated={() => {}} onCancel={() => {}} client={stubClient()} />);
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/scope/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/trigger/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^id/i)).not.toBeInTheDocument();
  });

  it("creates a seeded workflow under a generated id and reports that id", async () => {
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "x" } as never,
        path: "/x.yaml",
      }),
    );
    const onCreated = vi.fn();
    render(
      <NewWorkflowModal onCreated={onCreated} onCancel={() => {}} client={stubClient({ createWorkflow })} />,
    );

    await userEvent.type(screen.getByLabelText(/^name/i), "Fresh One");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    const body = createWorkflow.mock.calls[0]![0] as {
      workflow: { id: string; name: string; nodes: unknown[] };
    };
    expect(body.workflow.id).toMatch(/^[a-z]{6}$/);
    expect(body.workflow.name).toBe("Fresh One");
    expect(body.workflow.nodes).toHaveLength(1);
    // onCreated reports the same generated id that was posted.
    expect(onCreated).toHaveBeenCalledWith(body.workflow.id);
  });

  it("includes the cron schedule when the trigger is cron", async () => {
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "c" } as never,
        path: "/c.yaml",
      }),
    );
    render(
      <NewWorkflowModal onCreated={() => {}} onCancel={() => {}} client={stubClient({ createWorkflow })} />,
    );

    await userEvent.type(screen.getByLabelText(/^name/i), "Nightly");
    // Trigger is a Base UI Select (combobox): open it and pick the cron option.
    await userEvent.click(screen.getByRole("combobox", { name: /trigger/i }));
    await userEvent.click(await screen.findByRole("option", { name: "cron" }));
    await userEvent.type(screen.getByLabelText(/schedule/i), "0 5 * * *");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const body = createWorkflow.mock.calls[0]![0] as {
      workflow: { trigger: { type: string; schedule?: string } };
    };
    expect(body.workflow.trigger).toEqual({ type: "cron", schedule: "0 5 * * *" });
  });

  it("requires a name and does not call the API when it is blank", async () => {
    const createWorkflow = vi.fn();
    const onCreated = vi.fn();
    render(
      <NewWorkflowModal
        onCreated={onCreated}
        onCancel={() => {}}
        client={stubClient({ createWorkflow })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("surfaces a create rejection and does not report success", async () => {
    const createWorkflow = vi.fn(async () => {
      throw new Error("workflow 'abcdef' already exists");
    });
    const onCreated = vi.fn();
    render(
      <NewWorkflowModal
        onCreated={onCreated}
        onCancel={() => {}}
        client={stubClient({ createWorkflow })}
      />,
    );

    await userEvent.type(screen.getByLabelText(/^name/i), "Dup");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("cancels without creating", async () => {
    const onCancel = vi.fn();
    render(<NewWorkflowModal onCreated={() => {}} onCancel={onCancel} client={stubClient()} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
