import { describe, expect, test } from "bun:test";

import { evaluateCondition } from "../src/index.ts";
import type { RunState } from "../src/index.ts";

function run(nodes: RunState["nodes"]): RunState {
  return { run_id: "r1", workflow_id: "w", workflow_version: 1, status: "running", nodes };
}

describe("evaluateCondition — node_status", () => {
  const state = run({
    a: { node_id: "a", status: "completed", outcome: "success" },
    b: { node_id: "b", status: "completed", outcome: "failure" },
    c: { node_id: "c", status: "running" },
  });

  test("matches a success outcome", () => {
    expect(
      evaluateCondition({ type: "node_status", node: "a", equals: "success" }, state, "a"),
    ).toBe(true);
  });

  test("does not match the wrong outcome", () => {
    expect(
      evaluateCondition({ type: "node_status", node: "b", equals: "success" }, state, "b"),
    ).toBe(false);
  });

  test("is false when the node has no outcome yet", () => {
    expect(
      evaluateCondition({ type: "node_status", node: "c", equals: "success" }, state, "c"),
    ).toBe(false);
  });

  test("is false for an unknown node", () => {
    expect(
      evaluateCondition({ type: "node_status", node: "missing", equals: "success" }, state, "x"),
    ).toBe(false);
  });
});

describe("evaluateCondition — review_status", () => {
  const state = run({
    review: { node_id: "review", status: "waiting_for_review", review_decision: "approved" },
    pending: { node_id: "pending", status: "waiting_for_review" },
  });

  test("matches the recorded decision at the source node", () => {
    expect(evaluateCondition({ type: "review_status", equals: "approved" }, state, "review")).toBe(
      true,
    );
  });

  test("does not match a different decision", () => {
    expect(evaluateCondition({ type: "review_status", equals: "rejected" }, state, "review")).toBe(
      false,
    );
  });

  test("is false when no decision was recorded", () => {
    expect(evaluateCondition({ type: "review_status", equals: "approved" }, state, "pending")).toBe(
      false,
    );
  });
});
