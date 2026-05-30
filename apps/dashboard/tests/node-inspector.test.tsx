import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeInspector } from "../src/editor/NodeInspector";
import { WORKFLOW_NODE_TYPE, type FlowNode } from "../src/editor/graphMapping";
import type { WorkflowNode } from "../src/api/types";

function flowNode(node: WorkflowNode): FlowNode {
  return { id: node.id, type: WORKFLOW_NODE_TYPE, position: { x: 0, y: 0 }, data: { node } };
}

describe("NodeInspector", () => {
  it("prompts to select a node when nothing is selected", () => {
    render(<NodeInspector node={null} onChange={() => {}} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it("edits an agent_task prompt and profile", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "old", profile: "dev" });
    render(<NodeInspector node={node} onChange={onChange} />);

    expect(screen.getByLabelText("Prompt")).toHaveValue("old");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "new prompt" } });
    expect(onChange).toHaveBeenCalledWith({ prompt: "new prompt" });

    fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "qa-engineer" } });
    expect(onChange).toHaveBeenCalledWith({ profile: "qa-engineer" });
  });

  it("parses comma-separated skills into an array", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x" });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Skills"), { target: { value: "lint, test , " } });
    expect(onChange).toHaveBeenCalledWith({ skills: ["lint", "test"] });
  });

  it("toggles human_review options", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "gate", type: "human_review" });
    render(<NodeInspector node={node} onChange={onChange} />);

    // defaults to all three options checked
    expect(screen.getByLabelText("approved")).toBeChecked();
    await userEvent.click(screen.getByLabelText("approved"));
    expect(onChange).toHaveBeenCalledWith({ options: ["rejected", "needs_changes"] });
  });

  it("sets the finish outcome", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "done", type: "finish" });
    render(<NodeInspector node={node} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "failure");
    expect(onChange).toHaveBeenCalledWith({ outcome: "failure" });
  });

  it("edits the title for any node type", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "gate", type: "condition" });
    render(<NodeInspector node={node} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Quality gate" } });
    expect(onChange).toHaveBeenCalledWith({ title: "Quality gate" });
  });
});
