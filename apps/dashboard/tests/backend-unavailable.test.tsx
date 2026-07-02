import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BackendUnavailable } from "../src/ui/components/BackendUnavailable";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BackendUnavailable", () => {
  it("offers an agent prompt and a human step-by-step, and links to the docs", () => {
    render(<BackendUnavailable resource="workflows" />);

    expect(screen.getByText(/Could not load workflows/i)).toBeInTheDocument();
    expect(screen.getByText(/the request for workflows failed/i)).toBeInTheDocument();

    // Option 1: a ready-to-paste agent prompt that is persistent + update-proof.
    expect(screen.getByText(/let your agent do it/i)).toBeInTheDocument();
    expect(screen.getByText(/survives reboots and `hermes plugins update`/i)).toBeInTheDocument();
    // These tokens appear in both the agent prompt and the human steps.
    expect(screen.getAllByText(/hermes-workflows-dashboard-api/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\/api\/plugins\/hermes-workflows\/\*/).length).toBeGreaterThan(0);

    // Option 2: the human steps name the stable path and the sidecar port.
    expect(screen.getByText(/do it by hand/i)).toBeInTheDocument();
    expect(screen.getAllByText(/127\.0\.0\.1:9123/).length).toBeGreaterThan(0);

    const link = screen.getByRole("link", { name: /docs\/dashboard\.md/i });
    expect(link.getAttribute("href")).toContain("docs/dashboard.md");
  });

  it("copies the agent prompt to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BackendUnavailable resource="workflows" />);
    await userEvent.click(screen.getByRole("button", { name: /copy agent prompt/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain("/api/plugins/hermes-workflows/*");
    expect(copied).toContain("hermes-workflows-dashboard-api");
    expect(copied).toContain("hermes plugins update");
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("surfaces the underlying error message when provided, and omits it otherwise", () => {
    const { rerender } = render(<BackendUnavailable resource="runs" detail="404 Not Found" />);
    expect(screen.getByText(/the request for runs failed/i)).toBeInTheDocument();
    expect(screen.getByText(/404 Not Found/)).toBeInTheDocument();

    rerender(<BackendUnavailable resource="schedules" />);
    expect(screen.queryByText(/Backend error:/i)).not.toBeInTheDocument();
  });
});
