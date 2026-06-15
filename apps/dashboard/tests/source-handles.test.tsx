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

describe("SourceHandles", () => {
  it("shows only the two default outcomes for a work node", () => {
    renderHandles({ nodeType: "agent_task", editable: true });
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("failure")).toBeInTheDocument();
    expect(screen.queryByText("else")).not.toBeInTheDocument();
    expect(screen.queryByText("always")).not.toBeInTheDocument();
  });

  it("adds the next unused outcome via the + affordance", async () => {
    renderHandles({ nodeType: "agent_task", editable: true });
    await userEvent.click(screen.getByRole("button", { name: "Add branch point" }));
    expect(screen.getByText("else")).toBeInTheDocument();
  });

  it("always renders a handle used by an edge, even if not a default", () => {
    renderHandles({ nodeType: "agent_task", usedHandles: ["out"], editable: true });
    expect(screen.getByText("always")).toBeInTheDocument();
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
