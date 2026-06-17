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

  it("disables every control when readOnly (inspecting a running node)", () => {
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p", profile: "dev" });
    render(
      <NodeInspector
        node={node}
        onChange={() => {}}
        profiles={["dev", "qa-engineer"]}
        skills={["lint"]}
        readOnly
      />,
    );

    // The whole form is wrapped in a disabled fieldset, so every native input,
    // textarea, the Base UI select trigger, and the checkboxes report disabled.
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Prompt")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Profile" })).toBeDisabled();
    // The Base UI checkbox is a role=checkbox span (not a native control), so it
    // reports disabled via aria-disabled rather than the disabled attribute.
    expect(screen.getByRole("checkbox", { name: "lint" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("sets a per-node completion-notification override (tri-state)", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p" });
    render(<NodeInspector node={node} onChange={onChange} />);

    expect(screen.getByRole("combobox", { name: "Completion notification" })).toHaveTextContent(
      "Inherit workflow default",
    );
    await pickFromSelect("Completion notification", "Stay quiet for this node");
    expect(onChange).toHaveBeenCalledWith({ notify_completion: false });
  });

  it("clears a per-node notification override back to inherit", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p", notify_completion: true });
    render(<NodeInspector node={node} onChange={onChange} />);
    await pickFromSelect("Completion notification", "Inherit workflow default");
    expect(onChange).toHaveBeenCalledWith({ notify_completion: undefined });
  });

  it("takes an agent_task off the board when 'Run on the project board' is unchecked", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p" });
    render(<NodeInspector node={node} onChange={onChange} />);

    const toggle = screen.getByRole("checkbox", { name: /run on the project board/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ board: false });
  });

  it("restores an off-board agent_task to the board (board omitted)", async () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p", board: false });
    render(<NodeInspector node={node} onChange={onChange} />);

    const toggle = screen.getByRole("checkbox", { name: /run on the project board/i });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ board: undefined });
  });

  it("edits a wait node's PR reference and timeout", () => {
    const onChange = vi.fn();
    const node = flowNode({
      id: "merge",
      type: "wait",
      wait_for: { github_pr_merged: "" },
    });
    render(<NodeInspector node={node} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("PR reference"), {
      target: { value: "{{nodes.pr.output}}" },
    });
    expect(onChange).toHaveBeenCalledWith({
      wait_for: { github_pr_merged: "{{nodes.pr.output}}" },
    });

    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), { target: { value: "3600" } });
    expect(onChange).toHaveBeenCalledWith({ timeout_seconds: 3600 });
  });

  it("leaves controls enabled by default (editing a node)", () => {
    const node = flowNode({ id: "build", type: "agent_task", prompt: "p", profile: "dev" });
    render(<NodeInspector node={node} onChange={() => {}} profiles={["dev"]} />);
    expect(screen.getByLabelText("Prompt")).not.toBeDisabled();
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

  it("edits a prompt node's text, clearing it to undefined when emptied", () => {
    const onChange = vi.fn();
    const node = flowNode({ id: "p", type: "prompt", prompt: "ship it" });
    render(<NodeInspector node={node} onChange={onChange} />);

    const field = screen.getByLabelText("Prompt");
    expect(field).toHaveValue("ship it");
    fireEvent.change(field, { target: { value: "ship the urgent fix first" } });
    expect(onChange).toHaveBeenCalledWith({ prompt: "ship the urgent fix first" });
    // Emptying the optional field keeps it absent, not "".
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ prompt: undefined });
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
