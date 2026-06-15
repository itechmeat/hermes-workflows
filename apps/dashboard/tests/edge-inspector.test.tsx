import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EdgeInspector } from "../src/editor/EdgeInspector";
import { WORKFLOW_EDGE_TYPE, type FlowEdge } from "../src/editor/graphMapping";

function edge(over: Partial<FlowEdge> = {}): FlowEdge {
  return {
    id: "e1",
    source: "build",
    target: "done",
    type: WORKFLOW_EDGE_TYPE,
    data: {},
    ...over,
  };
}

async function pick(name: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("EdgeInspector", () => {
  it("conditions a plain edge on the source node's failure", async () => {
    const onChange = vi.fn();
    render(
      <EdgeInspector edge={edge()} sourceType="agent_task" nodeIds={["build", "done"]} onChange={onChange} />,
    );
    expect(screen.getByRole("combobox", { name: "Branch when" })).toHaveTextContent(
      "Always (plain / parallel)",
    );
    await pick("Branch when", "On failure");
    expect(onChange).toHaveBeenCalledWith({
      condition: { type: "node_status", node: "build", equals: "failure" },
    });
  });

  it("marks an edge as the fallback", async () => {
    const onChange = vi.fn();
    render(
      <EdgeInspector edge={edge()} sourceType="agent_task" nodeIds={["build", "done"]} onChange={onChange} />,
    );
    await pick("Branch when", "Fallback (else)");
    expect(onChange).toHaveBeenCalledWith({ fallback: true });
  });

  it("offers only the source node's real outcomes (no vanishing-edge picks)", async () => {
    render(
      <EdgeInspector edge={edge()} sourceType="agent_task" nodeIds={["build", "done"]} onChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Branch when" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    // A work node branches on success/failure, never a review decision.
    expect(options).toEqual(
      expect.arrayContaining(["On success", "On failure", "Fallback (else)"]),
    );
    expect(options).not.toContain("On approved");
    expect(options).not.toContain("On rejected");
  });

  it("offers the review decisions for a human_review source", async () => {
    render(
      <EdgeInspector
        edge={edge({ source: "gate" })}
        sourceType="human_review"
        nodeIds={["gate", "done"]}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Branch when" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["On approved", "On rejected", "On needs_changes"]),
    );
    expect(options).not.toContain("On success");
  });

  it("reveals a node picker for the advanced cross-node condition", async () => {
    render(
      <EdgeInspector
        edge={edge({ data: { condition: { type: "node_status", node: "qa", equals: "success" } } })}
        sourceType="agent_task"
        nodeIds={["build", "qa", "done"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Branch when" })).toHaveTextContent(
      "another node's status",
    );
    expect(screen.getByRole("combobox", { name: "Source node" })).toBeInTheDocument();
  });

  it("clears a conditioned edge back to plain", async () => {
    const onChange = vi.fn();
    render(
      <EdgeInspector
        edge={edge({ data: { fallback: true } })}
        sourceType="agent_task"
        nodeIds={["build", "done"]}
        onChange={onChange}
      />,
    );
    await pick("Branch when", "Always (plain / parallel)");
    expect(onChange).toHaveBeenCalledWith({});
  });
});
