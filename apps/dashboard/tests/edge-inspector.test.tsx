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
    render(<EdgeInspector edge={edge()} nodeIds={["build", "done"]} onChange={onChange} />);
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
    render(<EdgeInspector edge={edge()} nodeIds={["build", "done"]} onChange={onChange} />);
    await pick("Branch when", "Fallback (else)");
    expect(onChange).toHaveBeenCalledWith({ fallback: true });
  });

  it("reveals a node picker for the advanced cross-node condition", async () => {
    const onChange = vi.fn();
    render(
      <EdgeInspector
        edge={edge({ data: { condition: { type: "node_status", node: "qa", equals: "success" } } })}
        nodeIds={["build", "qa", "done"]}
        onChange={onChange}
      />,
    );
    // A condition on another node opens in the advanced mode with its source node.
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
        nodeIds={["build", "done"]}
        onChange={onChange}
      />,
    );
    await pick("Branch when", "Always (plain / parallel)");
    expect(onChange).toHaveBeenCalledWith({});
  });
});
