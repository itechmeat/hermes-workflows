import { describe, it, expect } from "vitest";
import { layout, type LayoutEdge, type LayoutNode } from "../src/editor/layout";

function nodes(...ids: string[]): LayoutNode[] {
  return ids.map((id) => ({ id }));
}

function edge(source: string, target: string): LayoutEdge {
  return { source, target };
}

describe("layout", () => {
  it("ranks a linear graph left-to-right on one row", () => {
    const pos = layout(nodes("a", "b", "c"), [edge("a", "b"), edge("b", "c")]);
    expect(pos["a"]!.x).toBeLessThan(pos["b"]!.x);
    expect(pos["b"]!.x).toBeLessThan(pos["c"]!.x);
    // a straight chain stays on a single row
    expect(pos["a"]!.y).toBe(pos["b"]!.y);
    expect(pos["b"]!.y).toBe(pos["c"]!.y);
  });

  it("places a branch's siblings on the same rank but different rows", () => {
    const pos = layout(nodes("a", "b", "c"), [edge("a", "b"), edge("a", "c")]);
    // b and c are both one rank past a -> same column, stacked rows
    expect(pos["b"]!.x).toBe(pos["c"]!.x);
    expect(pos["b"]!.x).toBeGreaterThan(pos["a"]!.x);
    expect(pos["b"]!.y).not.toBe(pos["c"]!.y);
  });

  it("terminates and ranks a graph with a router loop edge", () => {
    // a -> b -> a is a cycle; the back-edge must not create infinite ranks
    const pos = layout(nodes("a", "b"), [edge("a", "b"), edge("b", "a")]);
    expect(Object.keys(pos).toSorted()).toEqual(["a", "b"]);
    expect(pos["a"]!.x).toBeLessThan(pos["b"]!.x);
  });

  it("places a fully disconnected node in a trailing rank", () => {
    const pos = layout(nodes("a", "b", "lonely"), [edge("a", "b")]);
    // lonely has no edges -> trails the connected ranks
    expect(pos["lonely"]!.x).toBeGreaterThan(pos["b"]!.x);
  });

  it("returns a position for every node", () => {
    const ids = ["a", "b", "c", "d"];
    const pos = layout(nodes(...ids), [edge("a", "b"), edge("a", "c"), edge("c", "d")]);
    expect(Object.keys(pos).toSorted()).toEqual(ids);
  });
});
