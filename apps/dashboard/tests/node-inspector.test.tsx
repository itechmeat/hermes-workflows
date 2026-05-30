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

  it("edits script node command, workdir, timeout, and env allowlist", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "lint", type: "script", command: "old" });
    render(<NodeInspector node={node} onChange={onChange} />);

    expect(screen.getByLabelText("Command")).toHaveValue("old");
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "bun run lint" } });
    expect(onChange).toHaveBeenCalledWith({ command: "bun run lint" });

    fireEvent.change(screen.getByLabelText("Workdir"), { target: { value: "/srv/app" } });
    expect(onChange).toHaveBeenCalledWith({ workdir: "/srv/app" });

    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), { target: { value: "90" } });
    expect(onChange).toHaveBeenCalledWith({ timeout_seconds: 90 });

    fireEvent.change(screen.getByLabelText("Env allowlist"), { target: { value: "PATH, HOME ," } });
    expect(onChange).toHaveBeenCalledWith({ env: ["PATH", "HOME"] });
  });

  it("clears the script env allowlist to undefined when emptied", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "lint", type: "script", command: "x", env: ["PATH"] });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Env allowlist"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ env: undefined });
  });

  it("edits the title for any node type", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "gate", type: "condition" });
    render(<NodeInspector node={node} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Quality gate" } });
    expect(onChange).toHaveBeenCalledWith({ title: "Quality gate" });
  });

  it("edits the description for any node type", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "gate", type: "condition" });
    render(<NodeInspector node={node} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "routes by status" } });
    expect(onChange).toHaveBeenCalledWith({ description: "routes by status" });
  });

  it("edits agent_task workdir and workspace type", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x" });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Workdir"), { target: { value: "/srv/app" } });
    expect(onChange).toHaveBeenCalledWith({ workdir: "/srv/app" });

    await userEvent.selectOptions(screen.getByLabelText("Workspace"), "worktree");
    expect(onChange).toHaveBeenCalledWith({ workspace: { type: "worktree" } });
  });

  it("edits agent_task max_retries and timeout as numbers", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x" });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Max retries"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({ max_retries: 3 });

    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), { target: { value: "120" } });
    expect(onChange).toHaveBeenCalledWith({ timeout_seconds: 120 });
  });

  it("clears a numeric field to undefined when emptied", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x", max_retries: 5 });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Max retries"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ max_retries: undefined });
  });

  it("edits agent_task input_mapping rows and emits the map", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x" });
    render(<NodeInspector node={node} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /add mapping/i }));
    fireEvent.change(screen.getByLabelText("Mapping key 1"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("Mapping value 1"), {
      target: { value: "{{nodes.plan.output}}" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      input_mapping: { feature: "{{nodes.plan.output}}" },
    });
  });

  it("rejects duplicate input_mapping keys without emitting the collision", async () => {
    const onChange = vi.fn();
    const node = flowNode({
      id: "build",
      type: "agent_task",
      prompt: "x",
      input_mapping: { feature: "a" },
    });
    render(<NodeInspector node={node} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /add mapping/i }));
    onChange.mockClear();
    // second row reuses the existing key -> collision
    fireEvent.change(screen.getByLabelText("Mapping key 2"), { target: { value: "feature" } });

    expect(screen.getByText(/duplicate key/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("round-trips an empty input_mapping when the last row is removed", async () => {
    const onChange = vi.fn();
    const node = flowNode({
      id: "build",
      type: "agent_task",
      prompt: "x",
      input_mapping: { feature: "a" },
    });
    render(<NodeInspector node={node} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: /remove mapping 1/i }));
    expect(onChange).toHaveBeenLastCalledWith({ input_mapping: {} });
  });
});
