import { describe, expect, test } from "bun:test";

import { parseWorkflow, fromObject, WorkflowParseError, isWorkflowEnabled } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

const MINIMAL = {
  id: "x",
  name: "X",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  nodes: [{ id: "done", type: "finish" }],
  edges: [],
};

describe("parseWorkflow", () => {
  test("loads the feature-development example", async () => {
    const { workflow, ui } = await loadExample("feature-development.workflow.yaml");
    expect(workflow.id).toBe("feature-development");
    expect(workflow.trigger.type).toBe("manual");
    expect(workflow.nodes).toHaveLength(7);
    expect(ui).toBeUndefined();
  });

  test("loads the blog-daily-signals example with a cron trigger", async () => {
    const { workflow } = await loadExample("blog-daily-signals.workflow.yaml");
    expect(workflow.trigger).toEqual({
      type: "cron",
      schedule: "0 9 * * *",
      timezone: "Europe/Belgrade",
    });
  });

  test("separates the ui block from execution data", () => {
    const { workflow, ui } = fromObject({
      id: "x",
      name: "X",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes: [{ id: "done", type: "finish" }],
      edges: [],
      ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
    });
    expect(ui).toEqual({ xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } });
    expect("ui" in workflow).toBe(false);
  });

  test("a spec without ui still loads and is executable", () => {
    const { workflow, ui } = fromObject({
      id: "x",
      name: "X",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes: [{ id: "done", type: "finish" }],
      edges: [],
    });
    expect(ui).toBeUndefined();
    expect(workflow.nodes[0]?.type).toBe("finish");
  });

  test("rejects an agent_task without a prompt", () => {
    expect(() =>
      fromObject({
        id: "x",
        name: "X",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "a", type: "agent_task" }],
        edges: [],
      }),
    ).toThrow(WorkflowParseError);
  });

  test("rejects an unknown node type", () => {
    expect(() =>
      fromObject({
        id: "x",
        name: "X",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "a", type: "delay" }],
        edges: [],
      }),
    ).toThrow(WorkflowParseError);
  });

  test("rejects a non-mapping document", () => {
    expect(() => parseWorkflow("- just\n- a list")).toThrow(WorkflowParseError);
  });

  test("rejects an unknown memory provider", () => {
    expect(() =>
      fromObject({
        id: "x",
        name: "X",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "done", type: "finish" }],
        edges: [],
        defaults: { memory: { provider: "bogus" } },
      }),
    ).toThrow(WorkflowParseError);
  });

  test("parses an explicit enabled flag", () => {
    expect(fromObject({ ...MINIMAL, enabled: false }).workflow.enabled).toBe(false);
    expect(fromObject({ ...MINIMAL, enabled: true }).workflow.enabled).toBe(true);
  });

  test("leaves enabled absent when not specified", () => {
    expect("enabled" in fromObject(MINIMAL).workflow).toBe(false);
  });

  test("rejects a non-boolean enabled", () => {
    expect(() => fromObject({ ...MINIMAL, enabled: "yes" })).toThrow(WorkflowParseError);
  });

  test("isWorkflowEnabled treats absent and true as enabled, false as disabled", () => {
    expect(isWorkflowEnabled(fromObject(MINIMAL).workflow)).toBe(true);
    expect(isWorkflowEnabled(fromObject({ ...MINIMAL, enabled: true }).workflow)).toBe(true);
    expect(isWorkflowEnabled(fromObject({ ...MINIMAL, enabled: false }).workflow)).toBe(false);
  });

  test("accepts known memory providers", () => {
    for (const provider of ["auto", "open_second_brain", "none"] as const) {
      const { workflow } = fromObject({
        id: "x",
        name: "X",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "done", type: "finish" }],
        edges: [],
        defaults: { memory: { provider } },
      });
      expect(workflow.defaults?.memory?.provider).toBe(provider);
    }
  });
});
