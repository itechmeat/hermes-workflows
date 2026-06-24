import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "../src/pages/SettingsPage";
import type { WorkflowsApi } from "../src/api/client";
import type { SettingsResponse } from "../src/api/types";

const response: SettingsResponse = {
  values: { default_mode: "durable", max_parallel_runs: 4, fail_open: true, internal_board: "hermes-workflows" },
  schema: {
    namespace: "plugins.workflows",
    groups: [
      {
        key: "execution",
        label: "Execution",
        fields: [
          { key: "default_mode", type: "enum", enforced: true, default: "durable", options: ["durable", "direct"] },
          { key: "max_parallel_runs", type: "int", enforced: false, default: 4 },
        ],
      },
      {
        key: "open_second_brain",
        label: "OpenSecondBrain",
        fields: [
          { key: "fail_open", type: "bool", enforced: true, default: true },
          { key: "internal_board", type: "string", enforced: true, default: "hermes-workflows" },
        ],
      },
    ],
  },
};

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    getSettings: vi.fn(async () => response),
    saveSettings: vi.fn(async () => response),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

afterEach(() => vi.restoreAllMocks());

describe("SettingsPage", () => {
  it("renders every group and field from the schema", async () => {
    render(<SettingsPage client={stubClient()} />);
    expect(await screen.findByText("Execution")).toBeInTheDocument();
    expect(screen.getByText("OpenSecondBrain")).toBeInTheDocument();
    expect(screen.getByLabelText(/default mode/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max parallel runs/i)).toBeInTheDocument();
    // A bool renders as a switch (role=switch), labelled by its inline text.
    expect(screen.getByRole("switch", { name: /fail open/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/internal board/i)).toBeInTheDocument();
  });

  it("labels knobs that are not yet enforced", async () => {
    render(<SettingsPage client={stubClient()} />);
    await screen.findByText("Execution");
    expect(screen.getByText(/not yet enforced/i)).toBeInTheDocument();
  });

  it("edits a field and posts the values on save", async () => {
    const saveSettings = vi.fn(async (_values: Record<string, unknown>) => response);
    render(<SettingsPage client={stubClient({ saveSettings })} />);

    const board = await screen.findByLabelText(/internal board/i);
    await userEvent.clear(board);
    await userEvent.type(board, "my-board");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const sent = saveSettings.mock.calls[0]![0];
    expect(sent.internal_board).toBe("my-board");
  });

  it("shows a saved confirmation after a successful save", async () => {
    render(<SettingsPage client={stubClient()} />);
    await screen.findByLabelText(/internal board/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("renders a validation error inline when save is rejected", async () => {
    const saveSettings = vi.fn(async () => {
      throw new Error("'default_mode' must be one of ['durable', 'direct']");
    });
    render(<SettingsPage client={stubClient({ saveSettings })} />);
    await screen.findByLabelText(/internal board/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/must be one of/i)).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    const client = stubClient({
      getSettings: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<SettingsPage client={client} />);
    expect(await screen.findByText(/Could not load settings/i)).toBeInTheDocument();
    expect(screen.getByText(/the request for settings failed/i)).toBeInTheDocument();
  });
});
