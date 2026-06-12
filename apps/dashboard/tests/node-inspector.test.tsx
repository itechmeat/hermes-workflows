import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeInspector } from "../src/editor/NodeInspector";
import { WORKFLOW_NODE_TYPE, type FlowNode } from "../src/editor/graphMapping";
import type { WorkflowNode } from "../src/api/types";

function flowNode(node: WorkflowNode): FlowNode {
  return { id: node.id, type: WORKFLOW_NODE_TYPE, position: { x: 0, y: 0 }, data: { node } };
}

/** Open a Base UI Select (a combobox, not a native <select>) by its accessible
 *  name and click the named option. */
async function pickFromSelect(name: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("NodeInspector", () => {
  it("prompts to select a node when nothing is selected", () => {
    render(<NodeInspector node={null} onChange={() => {}} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it("edits an agent_task prompt and profile", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "old", profile: "dev" });
    render(<NodeInspector node={node} onChange={onChange} profiles={["dev", "qa-engineer"]} />);

    expect(screen.getByLabelText("Prompt")).toHaveValue("old");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "new prompt" } });
    expect(onChange).toHaveBeenCalledWith({ prompt: "new prompt" });

    // Profile is a select over the user's roster.
    await pickFromSelect("Profile", "qa-engineer");
    expect(onChange).toHaveBeenCalledWith({ profile: "qa-engineer" });
  });

  it("selects skills from the host catalog via checkboxes", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x", skills: ["lint"] });
    render(
      <NodeInspector node={node} onChange={onChange} skills={["lint", "test", "deploy"]} />,
    );

    // One checkbox per catalog skill; the node's current skill reads as checked.
    expect(screen.getByRole("checkbox", { name: "lint" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "test" })).not.toBeChecked();

    await userEvent.click(screen.getByRole("checkbox", { name: "test" }));
    expect(onChange).toHaveBeenCalledWith({ skills: ["lint", "test"] });
  });

  it("removes a skill when unchecked, clearing to undefined when none remain", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x", skills: ["lint"] });
    render(<NodeInspector node={node} onChange={onChange} skills={["lint", "test"]} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "lint" }));
    expect(onChange).toHaveBeenCalledWith({ skills: undefined });
  });

  it("preserves a legacy skill not present in the host catalog", () => {
    const onChange = vi.fn();
    const node = flowNode({
      id: "build",
      type: "agent_task",
      prompt: "x",
      skills: ["legacy-skill"],
    });
    render(<NodeInspector node={node} onChange={onChange} skills={["lint", "test"]} />);

    // The unknown current value is still shown and checked (mirrors the
    // model/profile preserve-unknown pattern), never silently dropped.
    expect(screen.getByRole("checkbox", { name: "legacy-skill" })).toBeChecked();
  });

  it("toggles human_review options", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "gate", type: "human_review" });
    render(<NodeInspector node={node} onChange={onChange} />);

    // defaults to all three options checked
    expect(screen.getByRole("checkbox", { name: "approved" })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "approved" }));
    expect(onChange).toHaveBeenCalledWith({ options: ["rejected", "needs_changes"] });
  });

  it("sets the finish outcome", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "done", type: "finish" });
    render(<NodeInspector node={node} onChange={onChange} />);

    await pickFromSelect("Outcome", "failure");
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

  it("edits agent_task workdir and workspace type", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "x" });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Workdir"), { target: { value: "/srv/app" } });
    expect(onChange).toHaveBeenCalledWith({ workdir: "/srv/app" });

    await pickFromSelect("Workspace", "worktree");
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
});
