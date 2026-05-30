import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ValidationPanel } from "../src/editor/ValidationPanel";
import { CompilePreview } from "../src/editor/CompilePreview";
import type { WorkflowsApi } from "../src/api/client";
import type { HermesPlan, ValidationResult } from "../src/api/types";

function client(overrides: Partial<WorkflowsApi>): WorkflowsApi {
  return overrides as unknown as WorkflowsApi;
}

describe("ValidationPanel", () => {
  it("shows blocking errors for an invalid graph", async () => {
    const result: ValidationResult = {
      valid: false,
      errors: [{ level: "error", code: "missing_profile", message: "agent_task 'build' has no profile" }],
      warnings: [],
    };
    const validateWorkflow = vi.fn(async () => result);
    render(<ValidationPanel workflowId="deploy" client={client({ validateWorkflow })} />);

    await userEvent.click(screen.getByRole("button", { name: /validate/i }));

    expect(validateWorkflow).toHaveBeenCalledWith("deploy");
    expect(await screen.findByText("missing_profile")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/fix before saving/i);
  });

  it("reports a valid graph and surfaces warnings", async () => {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [{ level: "warning", code: "unreachable_node", message: "node 'x' is unreachable" }],
    };
    render(<ValidationPanel workflowId="deploy" client={client({ validateWorkflow: vi.fn(async () => result) })} />);

    await userEvent.click(screen.getByRole("button", { name: /validate/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/valid/i);
    expect(screen.getByText("unreachable_node")).toBeInTheDocument();
  });

  it("surfaces a request failure instead of swallowing it", async () => {
    const validateWorkflow = vi.fn(async () => {
      throw new Error("network down");
    });
    render(<ValidationPanel workflowId="deploy" client={client({ validateWorkflow })} />);
    await userEvent.click(screen.getByRole("button", { name: /validate/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);
  });
});

describe("CompilePreview", () => {
  it("renders the compiled plan", async () => {
    const plan: HermesPlan = {
      workflow_id: "deploy",
      scope: { type: "global" },
      trigger: { type: "manual" },
      first_node: "build",
      kanban_tasks: [
        {
          node: "build",
          assignee: "devops-engineer",
          workflow_template_id: "deploy",
          current_step_key: "build",
          prompt: "build it",
        },
      ],
      cron_jobs: [],
      profiles: ["devops-engineer"],
      skills: [],
      memory: { provider: "auto", fail_open: true },
    };
    const compilePreview = vi.fn(async () => plan);
    render(<CompilePreview workflowId="deploy" client={client({ compilePreview })} />);

    await userEvent.click(screen.getByRole("button", { name: /preview plan/i }));

    expect(compilePreview).toHaveBeenCalledWith("deploy");
    expect(await screen.findByText(/1 Kanban task/i)).toBeInTheDocument();
    expect(screen.getByText(/Profiles: devops-engineer/)).toBeInTheDocument();
    // the compiled task row: node -> assignee
    expect(screen.getByText(/→ devops-engineer/)).toBeInTheDocument();
    expect(screen.getByText(/First node:/)).toBeInTheDocument();
  });

  it("surfaces a request failure instead of swallowing it", async () => {
    const compilePreview = vi.fn(async () => {
      throw new Error("compile boom");
    });
    render(<CompilePreview workflowId="deploy" client={client({ compilePreview })} />);
    await userEvent.click(screen.getByRole("button", { name: /preview plan/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/compile boom/i);
  });
});
