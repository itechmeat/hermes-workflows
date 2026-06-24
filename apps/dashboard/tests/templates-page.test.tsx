import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TemplatesPage } from "../src/pages/TemplatesPage";
import type { WorkflowsApi } from "../src/api/client";
import type { CreateWorkflowBody, SpecDetail, WorkflowListItem } from "../src/api/types";

/** Row actions live behind a per-row "Actions" dropdown: open the row's menu,
 *  then click the named item. */
async function clickRowAction(row: number, name: RegExp): Promise<void> {
  await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[row]!);
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}

/** jsdom Blobs lack `.text()`; FileReader works in both jsdom and browsers. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    listWorkflows: vi.fn(async () => [] as WorkflowListItem[]),
    runWorkflow: vi.fn(async () => ({ run_id: "wf-1-abc", status: "running" as const })),
    getWorkflow: vi.fn(
      async (id: string): Promise<SpecDetail> => ({
        workflow: { id, name: "Source" } as never,
        ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
        path: `/x/${id}.workflow.yaml`,
      }),
    ),
    createWorkflow: vi.fn(async (): Promise<SpecDetail> => ({ workflow: {} as never, path: "" })),
    deleteWorkflow: vi.fn(async () => ({ deleted: true })),
    setWorkflowEnabled: vi.fn(async (id: string, enabled: boolean) => ({
      workflow: { id, enabled } as never,
      path: `/x/${id}.workflow.yaml`,
    })),
    exportWorkflow: vi.fn(async (id: string) => ({
      id,
      filename: `${id}.workflow.yaml`,
      yaml: `id: ${id}\n`,
    })),
    exportTemplate: vi.fn(async (id: string) => ({
      id,
      cached: false,
      revision: "9c3a0000",
      human_version: "fmt1·wf1·r9c3a",
      spec_sha: "sha256:00",
      yaml_filename: `${id}.template.yaml`,
      yaml: `id: ${id}\n`,
      md_filename: `${id}.template.md`,
      md: "# guide\n",
    })),
    listModels: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

const items: WorkflowListItem[] = [
  {
    id: "deploy",
    name: "Deploy",
    scope: "global",
    trigger: { type: "manual" },
    enabled: true,
    last_run_at: 1_700_000_000,
    last_status: "completed",
    next_run_at: null,
  },
  {
    id: "nightly",
    name: "Nightly",
    scope: "project",
    trigger: { type: "cron", schedule: "0 5 * * *" },
    enabled: false,
    last_run_at: null,
    last_status: null,
    next_run_at: "2026-06-01T05:00:00Z",
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
    await clickRowAction(0, /open/i);

    expect(onOpen).toHaveBeenCalledWith("deploy");
  });

  it("opens a workflow when its name link is clicked", async () => {
    const onOpen = vi.fn();
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={onOpen} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("link", { name: "Deploy" }));

    expect(onOpen).toHaveBeenCalledWith("deploy");
  });

  it("starts a run and reports the new run id when Run is clicked", async () => {
    const runWorkflow = vi.fn(async () => ({ run_id: "deploy-12345678", status: "running" as const }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), runWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /^run$/i);

    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith("deploy"));
    expect(await screen.findByText(/deploy-12345678/)).toBeInTheDocument();
  });

  it("surfaces the server detail when a run is refused (scripts disabled)", async () => {
    const runWorkflow = vi.fn(async () => {
      throw new Error("workflow contains script nodes but execution.scripts_enabled is false");
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => items), runWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /^run$/i);

    expect(await screen.findByText(/scripts_enabled is false/)).toBeInTheDocument();
  });

  it("shows the run/schedule columns and the enabled state", async () => {
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    // last status of the most recent run shows for the enabled row
    expect(screen.getByText("completed")).toBeInTheDocument();
    // the cron workflow's next-run timestamp surfaces, formatted (not raw ISO)
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.queryByText("2026-06-01T05:00:00Z")).not.toBeInTheDocument();
    // the disabled row carries a Disabled marker
    expect(screen.getByText(/disabled/i)).toBeInTheDocument();
  });

  it("disables the Run action for a disabled workflow", async () => {
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Nightly");
    // rows render in list order: [0]=deploy(enabled), [1]=nightly(disabled)
    await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[0]!);
    expect(screen.getByRole("menuitem", { name: /^run$/i })).not.toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[1]!);
    expect(screen.getByRole("menuitem", { name: /^run$/i })).toBeDisabled();
  });

  it("toggles a workflow off via the Disable action and refreshes", async () => {
    const setWorkflowEnabled = vi.fn(async (id: string, enabled: boolean) => ({
      workflow: { id, enabled } as never,
      path: "",
    }));
    const listWorkflows = vi.fn(async () => items);
    const client = stubClient({ listWorkflows, setWorkflowEnabled });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    // deploy is enabled -> its toggle reads "Disable"
    await clickRowAction(0, /^disable$/i);

    await waitFor(() => expect(setWorkflowEnabled).toHaveBeenCalledWith("deploy", false));
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
  });

  it("toggles a disabled workflow back on via the Enable action", async () => {
    const setWorkflowEnabled = vi.fn(async (id: string, enabled: boolean) => ({
      workflow: { id, enabled } as never,
      path: "",
    }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), setWorkflowEnabled });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Nightly");
    // nightly is row 1 (disabled) -> its toggle reads "Enable"
    await clickRowAction(1, /^enable$/i);

    await waitFor(() => expect(setWorkflowEnabled).toHaveBeenCalledWith("nightly", true));
  });

  it("surfaces a load error", async () => {
    const client = stubClient({
      listWorkflows: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<TemplatesPage client={client} onOpen={() => {}} />);
    expect(await screen.findByText(/Could not load workflows/i)).toBeInTheDocument();
    expect(screen.getByText(/the request for workflows failed/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});

describe("TemplatesPage — row lifecycle actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("duplicates a workflow under a prompted new id and refreshes", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("deploy-copy");
    const getWorkflow = vi.fn(
      async (id: string): Promise<SpecDetail> => ({
        workflow: { id, name: "Deploy" } as never,
        ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
        path: `/x/${id}.workflow.yaml`,
      }),
    );
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({ workflow: {} as never, path: "" }),
    );
    const listWorkflows = vi.fn(async () => items);
    const client = stubClient({ listWorkflows, getWorkflow, createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /duplicate/i);

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    expect(getWorkflow).toHaveBeenCalledWith("deploy");
    const body = createWorkflow.mock.calls[0]![0] as { workflow: { id: string }; ui?: unknown };
    expect(body.workflow.id).toBe("deploy-copy");
    expect(body.ui).toBeDefined();
    // list re-fetched after the copy
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
  });

  it("does not duplicate when the prompted id is not a valid slug", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("bad id!");
    const createWorkflow = vi.fn(async (): Promise<SpecDetail> => ({ workflow: {} as never, path: "" }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /duplicate/i);

    expect(createWorkflow).not.toHaveBeenCalled();
    expect(await screen.findByText(/not a valid id/i)).toBeInTheDocument();
  });

  it("does not duplicate when the prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const createWorkflow = vi.fn(async (): Promise<SpecDetail> => ({ workflow: {} as never, path: "" }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /duplicate/i);

    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("deletes a workflow after confirmation and refreshes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteWorkflow = vi.fn(async () => ({ deleted: true }));
    const listWorkflows = vi.fn(async () => items);
    const client = stubClient({ listWorkflows, deleteWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /delete/i);

    await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith("deploy"));
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
  });

  it("does not delete when the confirm is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteWorkflow = vi.fn(async () => ({ deleted: true }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), deleteWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /delete/i);

    expect(deleteWorkflow).not.toHaveBeenCalled();
  });

  it("opens the New modal and reports the generated id via onCreated", async () => {
    const onCreated = vi.fn();
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "x" } as never,
        path: "",
      }),
    );
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} onCreated={onCreated} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /new workflow/i }));
    await userEvent.type(screen.getByLabelText(/^name/i), "Brand");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]![0]).toMatch(/^[a-z]{6}$/);
  });

  it("closes the New modal on cancel", async () => {
    const client = stubClient({ listWorkflows: vi.fn(async () => items) });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await userEvent.click(screen.getByRole("button", { name: /new workflow/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exports a workflow as a YAML download", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const exportWorkflow = vi.fn(async (id: string) => ({
      id,
      filename: `${id}.workflow.yaml`,
      yaml: `id: ${id}\n`,
    }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), exportWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /export yaml/i);

    await waitFor(() => expect(exportWorkflow).toHaveBeenCalledWith("deploy"));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("exports a workflow as a template (two downloads: spec + guide)", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const exportTemplate = vi.fn(async (id: string) => ({
      id,
      cached: false,
      revision: "9c3a0000",
      human_version: "fmt1·wf1·r9c3a",
      spec_sha: "sha256:00",
      yaml_filename: `${id}.template.yaml`,
      yaml: `id: ${id}\n`,
      md_filename: `${id}.template.md`,
      md: "# guide\n",
    }));
    const client = stubClient({ listWorkflows: vi.fn(async () => items), exportTemplate });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /export as template/i);

    await waitFor(() => expect(exportTemplate).toHaveBeenCalledWith("deploy"));
    // One object URL per downloaded artifact: the spec and the guide.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("exports a workflow as a JSON download of the authoring shape", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    let downloaded: Blob | undefined;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      downloaded = blob;
      return "blob:x";
    });
    const getWorkflow = vi.fn(
      async (id: string): Promise<SpecDetail> => ({
        workflow: { id, name: "Deploy" } as never,
        ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
        path: `/x/${id}.workflow.yaml`,
      }),
    );
    const client = stubClient({ listWorkflows: vi.fn(async () => items), getWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /export json/i);

    await waitFor(() => expect(getWorkflow).toHaveBeenCalledWith("deploy"));
    expect(downloaded).toBeDefined();
    expect(downloaded?.type).toBe("application/json");
    const parsed = JSON.parse(await blobText(downloaded!));
    expect(parsed).toEqual({
      workflow: { id: "deploy", name: "Deploy" },
      ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
    });
  });

  it("surfaces a JSON export failure in the status line", async () => {
    const getWorkflow = vi.fn(async () => {
      throw new Error("spec store offline");
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => items), getWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await clickRowAction(0, /export json/i);

    expect(await screen.findByText(/spec store offline/i)).toBeInTheDocument();
  });
});

describe("TemplatesPage — JSON import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const importedBody = {
    workflow: { id: "imported", name: "Imported" },
    ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
  };

  function importFile(content: string, name = "imported.workflow.json"): File {
    return new File([content], name, { type: "application/json" });
  }

  /** The Import button drives a hidden file input (label wiring). */
  async function pickImportFile(file: File): Promise<void> {
    const input = screen.getByLabelText(/import workflow json/i);
    await userEvent.upload(input, file);
  }

  it("imports a workflow JSON file, reports the id, and refreshes", async () => {
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "imported" } as never,
        path: "",
      }),
    );
    const listWorkflows = vi.fn(async () => items);
    const client = stubClient({ listWorkflows, createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify(importedBody)));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    expect(createWorkflow.mock.calls[0]![0]).toEqual(importedBody);
    expect(await screen.findByText(/imported "imported"/i)).toBeInTheDocument();
    await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
  });

  it("surfaces the server detail when the imported id clashes (409)", async () => {
    const createWorkflow = vi.fn(async () => {
      throw new Error("workflow 'imported' already exists");
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify(importedBody)));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it("surfaces the server detail when the imported graph is invalid (400)", async () => {
    const createWorkflow = vi.fn(async () => {
      throw new Error("edge 'a -> ghost' points to an unknown node");
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify(importedBody)));

    expect(await screen.findByText(/unknown node/i)).toBeInTheDocument();
  });

  it("rejects a non-workflow JSON file without calling the API", async () => {
    const createWorkflow = vi.fn();
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify({ runs: [] }), "runs.json"));

    expect(await screen.findByText(/not a workflow JSON export/i)).toBeInTheDocument();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the parse reason", async () => {
    const createWorkflow = vi.fn();
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile("{broken", "broken.json"));

    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("resets node model/profile/skills the host doesn't have, and reports it", async () => {
    const bodyWithUnknowns = {
      workflow: {
        id: "imported",
        name: "Imported",
        nodes: [
          {
            id: "work",
            type: "agent_task",
            prompt: "do",
            model: "ghost@nowhere",
            profile: "missing-agent",
            skills: ["known-skill", "ghost-skill"],
          },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "work", to: "done" }],
      },
    };
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "imported" } as never,
        path: "",
      }),
    );
    const client = stubClient({
      listWorkflows: vi.fn(async () => items),
      createWorkflow,
      listModels: vi.fn(async () => [{ provider: "openai", label: "OpenAI", models: ["gpt-4o"] }]),
      listProfiles: vi.fn(async () => ["known-agent"]),
      listSkills: vi.fn(async () => ["known-skill"]),
    });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify(bodyWithUnknowns)));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    const sent = createWorkflow.mock.calls[0]![0] as CreateWorkflowBody;
    const work = sent.workflow.nodes.find((n) => n.id === "work")!;
    // Unknown model + profile dropped (fall back to defaults); only the known
    // skill survives.
    expect(work).not.toHaveProperty("model");
    expect(work).not.toHaveProperty("profile");
    expect(work.type === "agent_task" && work.skills).toEqual(["known-skill"]);
    expect(await screen.findByText(/reset unknown 1 model, 1 profile, 1 skill/i)).toBeInTheDocument();
  });

  it("leaves a dimension untouched when its host lookup fails", async () => {
    const bodyWithModel = {
      workflow: {
        id: "imported",
        name: "Imported",
        nodes: [
          { id: "work", type: "agent_task", prompt: "do", model: "ghost@nowhere" },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "work", to: "done" }],
      },
    };
    const createWorkflow = vi.fn(
      async (_body: CreateWorkflowBody): Promise<SpecDetail> => ({
        workflow: { id: "imported" } as never,
        path: "",
      }),
    );
    const client = stubClient({
      listWorkflows: vi.fn(async () => items),
      createWorkflow,
      // The model lookup is down: the model must NOT be stripped, and the gap
      // is reported instead of silently treated as "unknown".
      listModels: vi.fn(async () => {
        throw new Error("model picker offline");
      }),
    });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    await pickImportFile(importFile(JSON.stringify(bodyWithModel)));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    const sent = createWorkflow.mock.calls[0]![0] as CreateWorkflowBody;
    const work = sent.workflow.nodes.find((n) => n.id === "work")!;
    expect(work.type === "agent_task" && work.model).toBe("ghost@nowhere");
    expect(await screen.findByText(/could not verify models/i)).toBeInTheDocument();
  });

  it("allows picking the same file again after a failure", async () => {
    const createWorkflow = vi.fn(async () => {
      throw new Error("workflow 'imported' already exists");
    });
    const client = stubClient({ listWorkflows: vi.fn(async () => items), createWorkflow });
    render(<TemplatesPage client={client} onOpen={() => {}} />);

    await screen.findByText("Deploy");
    const file = importFile(JSON.stringify(importedBody));
    await pickImportFile(file);
    await screen.findByText(/already exists/i);
    await pickImportFile(file);

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(2));
  });
});
