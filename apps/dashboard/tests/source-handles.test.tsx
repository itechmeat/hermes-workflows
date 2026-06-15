import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { SourceHandles } from "../src/editor/nodes/SourceHandles";

function renderHandles(props: Parameters<typeof SourceHandles>[0]) {
  return render(
    <ReactFlowProvider>
      <SourceHandles {...props} />
    </ReactFlowProvider>,
  );
}

// No text labels: a handle is identified by its tone class on the dot.
const dots = (root: HTMLElement) => root.querySelectorAll(".hw-handle");
const hasTone = (root: HTMLElement, tone: string) =>
  root.querySelector(`.hw-handle--${tone}`) !== null;

describe("SourceHandles", () => {
  it("shows only the two default outcomes (success, failure) for a work node", () => {
    const { container } = renderHandles({ nodeType: "agent_task", editable: true });
    expect(dots(container)).toHaveLength(2);
    expect(hasTone(container, "success")).toBe(true);
    expect(hasTone(container, "failure")).toBe(true);
    expect(hasTone(container, "else")).toBe(false);
  });

  it("renders no text labels next to the handles", () => {
    renderHandles({ nodeType: "agent_task", editable: true });
    expect(screen.queryByText("success")).not.toBeInTheDocument();
    expect(screen.queryByText("failure")).not.toBeInTheDocument();
  });

  it("adds the next unused outcome via the + affordance", async () => {
    const { container } = renderHandles({ nodeType: "agent_task", editable: true });
    await userEvent.click(screen.getByRole("button", { name: "Add branch point" }));
    expect(dots(container)).toHaveLength(3);
    expect(hasTone(container, "else")).toBe(true);
  });

  it("always renders a handle used by an edge, even if not a default", () => {
    const { container } = renderHandles({
      nodeType: "agent_task",
      usedHandles: ["out"],
      editable: true,
    });
    // success + failure (defaults) + out (used).
    expect(dots(container)).toHaveLength(3);
    expect(hasTone(container, "plain")).toBe(true);
  });

  it("disables + once every outcome is shown", async () => {
    renderHandles({ nodeType: "agent_task", editable: true });
    const add = screen.getByRole("button", { name: "Add branch point" });
    await userEvent.click(add); // + else
    await userEvent.click(add); // + always
    expect(add).toBeDisabled();
  });

  it("shows no add affordance when not editable (run canvas)", () => {
    renderHandles({ nodeType: "agent_task", editable: false });
    expect(screen.queryByRole("button", { name: "Add branch point" })).not.toBeInTheDocument();
  });
});
