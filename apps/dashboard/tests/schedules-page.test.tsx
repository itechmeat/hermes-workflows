import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchedulesPage } from "../src/pages/SchedulesPage";
import type { WorkflowsApi } from "../src/api/client";
import type { ScheduleListItem } from "../src/api/types";

/** Row actions live behind a per-row "Actions" dropdown: open the row's menu,
 *  then click the named item. */
async function clickRowAction(name: RegExp, row = 0): Promise<void> {
  await userEvent.click(screen.getAllByRole("button", { name: /^actions$/i })[row]!);
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}

function stubClient(overrides: Partial<WorkflowsApi> = {}): WorkflowsApi {
  const base = {
    listSchedules: vi.fn(async () => [] as ScheduleListItem[]),
    pauseSchedule: vi.fn(async () => ({ ok: true })),
    resumeSchedule: vi.fn(async () => ({ ok: true })),
    runScheduleNow: vi.fn(async () => ({ ok: true })),
    editSchedule: vi.fn(async () => ({ ok: true })),
    deleteSchedule: vi.fn(async () => ({ deleted: true })),
  };
  return { ...base, ...overrides } as unknown as WorkflowsApi;
}

const schedules: ScheduleListItem[] = [
  {
    workflow_id: "blog",
    cron_expression: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    last_run: null,
    next_run: "2026-06-01T09:00:00Z",
    hermes_cron_id: "cron-blog-1",
  },
];

afterEach(() => vi.restoreAllMocks());

describe("SchedulesPage", () => {
  it("renders a row per schedule with the page columns", async () => {
    const client = stubClient({ listSchedules: vi.fn(async () => schedules) });
    render(<SchedulesPage client={client} />);

    expect(await screen.findByText("blog")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(screen.getByText("cron-blog-1")).toBeInTheDocument();
  });

  it("tags each row as a Workflow schedule and positions it against blueprints", async () => {
    const client = stubClient({ listSchedules: vi.fn(async () => schedules) });
    const { container } = render(<SchedulesPage client={client} />);
    await screen.findByText("blog");
    // A neutral kind badge marks the row as a Workflow-trigger schedule,
    // distinct from a host Automation Blueprint cron job.
    expect(container.querySelector(".hw-badge--kind")?.textContent).toBe("Workflow");
    expect(screen.getByText(/Automation Blueprints/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no schedules", async () => {
    render(<SchedulesPage client={stubClient()} />);
    expect(await screen.findByText(/no schedules/i)).toBeInTheDocument();
  });

  it("explains where schedules come from, linking to the Workflows section", async () => {
    render(<SchedulesPage client={stubClient()} />);
    const link = await screen.findByRole("link", { name: /workflows/i });
    expect(link).toHaveAttribute("href", "#workflows");
  });

  it("pauses a schedule and refreshes", async () => {
    const pauseSchedule = vi.fn(async () => ({ ok: true }));
    const listSchedules = vi.fn(async () => schedules);
    render(<SchedulesPage client={stubClient({ listSchedules, pauseSchedule })} />);

    await screen.findByText("blog");
    await clickRowAction(/pause/i);
    await waitFor(() => expect(pauseSchedule).toHaveBeenCalledWith("cron-blog-1"));
    await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(2));
  });

  it("resumes a schedule", async () => {
    const resumeSchedule = vi.fn(async () => ({ ok: true }));
    render(<SchedulesPage client={stubClient({ listSchedules: vi.fn(async () => schedules), resumeSchedule })} />);
    await screen.findByText("blog");
    await clickRowAction(/resume/i);
    await waitFor(() => expect(resumeSchedule).toHaveBeenCalledWith("cron-blog-1"));
  });

  it("runs a schedule now", async () => {
    const runScheduleNow = vi.fn(async () => ({ ok: true }));
    render(<SchedulesPage client={stubClient({ listSchedules: vi.fn(async () => schedules), runScheduleNow })} />);
    await screen.findByText("blog");
    await clickRowAction(/run now/i);
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledWith("cron-blog-1"));
  });

  it("edits the cron via a prompt and refreshes", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("30 7 * * *");
    const editSchedule = vi.fn(async () => ({ ok: true }));
    const listSchedules = vi.fn(async () => schedules);
    render(<SchedulesPage client={stubClient({ listSchedules, editSchedule })} />);

    await screen.findByText("blog");
    await clickRowAction(/edit/i);
    await waitFor(() => expect(editSchedule).toHaveBeenCalledWith("cron-blog-1", "30 7 * * *"));
    await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(2));
  });

  it("does not edit when the prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const editSchedule = vi.fn(async () => ({ ok: true }));
    render(<SchedulesPage client={stubClient({ listSchedules: vi.fn(async () => schedules), editSchedule })} />);
    await screen.findByText("blog");
    await clickRowAction(/edit/i);
    expect(editSchedule).not.toHaveBeenCalled();
  });

  it("deletes a schedule after confirmation and refreshes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteSchedule = vi.fn(async () => ({ deleted: true }));
    const listSchedules = vi.fn(async () => schedules);
    render(<SchedulesPage client={stubClient({ listSchedules, deleteSchedule })} />);

    await screen.findByText("blog");
    await clickRowAction(/delete/i);
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith("cron-blog-1"));
    await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(2));
  });

  it("surfaces a load error", async () => {
    const client = stubClient({
      listSchedules: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(<SchedulesPage client={client} />);
    expect(await screen.findByText(/Could not load schedules/i)).toBeInTheDocument();
    expect(screen.getByText(/the request for schedules failed/i)).toBeInTheDocument();
  });
});
