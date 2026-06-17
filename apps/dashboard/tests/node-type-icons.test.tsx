import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { isValidElement, type ComponentProps, type ReactElement } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { NODE_TYPE_ICON, nodeTypeIcon } from "../src/editor/nodeTypeIcons";
import { WorkflowNodeView } from "../src/editor/nodes/WorkflowNodeView";
import { RunNodeView } from "../src/run/RunNodeView";
import type { NodeType } from "../src/api/types";

const ALL_TYPES: NodeType[] = [
  "agent_task",
  "script",
  "condition",
  "human_review",
  "finish",
  "wait",
  "prompt",
];

// The node views render @xyflow `Handle`s, which need the ReactFlow store.
function renderNode(ui: ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe("nodeTypeIcons", () => {
  it("maps every node type to a renderable icon element", () => {
    for (const type of ALL_TYPES) {
      expect(isValidElement(NODE_TYPE_ICON[type])).toBe(true);
      expect(isValidElement(nodeTypeIcon(type))).toBe(true);
    }
  });

  it("renders the type icon before the label on a canvas node", () => {
    const props = {
      data: { node: { id: "build", type: "agent_task", prompt: "go", profile: "p" } },
      selected: false,
    } as unknown as ComponentProps<typeof WorkflowNodeView>;
    const { container } = renderNode(<WorkflowNodeView {...props} />);
    const head = container.querySelector(".hw-node__type");
    expect(head).not.toBeNull();
    // The icon is an svg marked with the shared hw-icon class, before the label.
    const icon = head?.querySelector("svg.hw-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the type icon on a run-canvas node too", () => {
    const props = {
      data: { node: { id: "build", type: "script", command: "ls" }, status: "running" },
      selected: false,
    } as unknown as ComponentProps<typeof RunNodeView>;
    const { container } = renderNode(<RunNodeView {...props} />);
    expect(container.querySelector(".hw-node__type svg.hw-icon")).not.toBeNull();
  });
});
