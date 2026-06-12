import { describe, expect, test } from "bun:test";

import {
  fromObject,
  parseWorkflow,
  serializeWorkflow,
  compileToHermesPlan,
  validateWorkflow,
} from "../src/index.ts";
import type { Workflow } from "../src/index.ts";

function wf(extra: Record<string, unknown> = {}): Workflow {
  return fromObject({
    id: "t",
    name: "T",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { profile: "p" },
    nodes: [
      { id: "a", type: "agent_task", prompt: "x" },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "a", to: "done" }],
    ...extra,
  }).workflow;
}

describe("workflow.deliver", () => {
  test("absent by default", () => {
    expect(wf().deliver).toBeUndefined();
  });

  test("parses a DeliveryTarget string", () => {
    expect(wf({ deliver: "telegram:-100123:42" }).deliver).toBe("telegram:-100123:42");
  });

  test("accepts the literal 'origin'", () => {
    expect(wf({ deliver: "origin" }).deliver).toBe("origin");
  });

  // Mirrors the host blueprint `_DELIVER` slot (strict=false): the gateway
  // validates platforms downstream, so we never hardcode a closed list.
  test("accepts any DeliveryTarget-shaped string at parse time", () => {
    expect(wf({ deliver: "some-future-platform:abc" }).deliver).toBe("some-future-platform:abc");
  });

  test("round-trips through serialize", () => {
    const w = wf({ deliver: "discord" });
    const round = parseWorkflow(serializeWorkflow(w)).workflow;
    expect(round.deliver).toBe("discord");
  });

  test("compile-preview surfaces deliver when set", () => {
    expect(compileToHermesPlan(wf({ deliver: "telegram:1:2" })).deliver).toBe("telegram:1:2");
  });

  test("compile-preview omits deliver when unset", () => {
    expect(compileToHermesPlan(wf()).deliver).toBeUndefined();
  });

  test("validation rejects an empty/whitespace deliver", () => {
    const result = validateWorkflow(wf({ deliver: "  " }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "empty_deliver")).toBe(true);
  });

  test("validation passes a concrete deliver", () => {
    expect(validateWorkflow(wf({ deliver: "telegram:1:2" })).valid).toBe(true);
  });
});
