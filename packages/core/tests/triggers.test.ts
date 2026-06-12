import { describe, expect, test } from "bun:test";

import {
  fromObject,
  parseWorkflow,
  serializeWorkflow,
  compileToHermesPlan,
  validateWorkflow,
} from "../src/index.ts";
import type { Workflow, Trigger } from "../src/index.ts";

function wf(trigger: unknown): Workflow {
  return fromObject({
    id: "t",
    name: "T",
    version: 1,
    scope: { type: "global" },
    trigger,
    defaults: { profile: "p" },
    nodes: [
      { id: "a", type: "agent_task", prompt: "Triage {{pr}}", profile: "p", input_mapping: {} },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "a", to: "done" }],
  }).workflow;
}

const WEBHOOK: Trigger = {
  type: "webhook",
  events: ["push"],
  event_mapping: { repo: "{event.repository.full_name}" },
};
const GITHUB: Trigger = {
  type: "github",
  events: ["pull_request", "issues"],
  event_mapping: { title: "{event.pull_request.title}" },
};
const API: Trigger = { type: "api", events: ["deploy"] };

describe("event triggers — parsing", () => {
  test("parses webhook / github / api triggers", () => {
    expect(wf(WEBHOOK).trigger).toEqual(WEBHOOK);
    expect(wf(GITHUB).trigger).toEqual(GITHUB);
    expect(wf(API).trigger).toEqual(API);
  });

  test("round-trips through serialize", () => {
    const w = wf(GITHUB);
    expect(parseWorkflow(serializeWorkflow(w)).workflow.trigger).toEqual(GITHUB);
  });

  test("rejects an unknown trigger type", () => {
    expect(() => wf({ type: "carrier-pigeon" })).toThrow();
  });

  test("rejects an event trigger with a non-list events field", () => {
    expect(() => wf({ type: "webhook", events: "push" })).toThrow();
  });
});

describe("event triggers — validation", () => {
  test("requires at least one event", () => {
    const result = validateWorkflow(wf({ type: "webhook", events: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "empty_events")).toBe(true);
  });

  test("rejects an event_mapping value not in the {event.*} namespace", () => {
    const result = validateWorkflow(
      wf({ type: "github", events: ["push"], event_mapping: { x: "{{nodes.a.output}}" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "invalid_event_mapping_ref")).toBe(true);
  });

  test("accepts a well-formed event trigger", () => {
    expect(validateWorkflow(wf(GITHUB)).valid).toBe(true);
    expect(validateWorkflow(wf(API)).valid).toBe(true);
  });
});

describe("event triggers — compile preview", () => {
  test("surfaces the trigger and emits no cron job (not time-based)", () => {
    const plan = compileToHermesPlan(wf(GITHUB));
    expect(plan.trigger).toEqual(GITHUB);
    expect(plan.cron_jobs).toHaveLength(0);
  });
});
