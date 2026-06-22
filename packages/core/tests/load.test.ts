import { describe, expect, test } from "bun:test";

import {
  parseWorkflow,
  fromObject,
  serializeWorkflow,
  WorkflowParseError,
  isWorkflowEnabled,
} from "../src/index.ts";
import type { ScriptNode } from "../src/index.ts";
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

  test("parses stack + branch on an adopt node", () => {
    const { workflow } = fromObject({
      id: "x",
      name: "X",
      version: 1,
      scope: { type: "project" },
      trigger: { type: "manual" },
      nodes: [
        {
          id: "drive",
          type: "agent_task",
          prompt: "drive",
          adopt: true,
          task_ref: "t_abc123",
          stack: true,
          branch: "feat/release",
        },
        { id: "done", type: "finish" },
      ],
      edges: [{ from: "drive", to: "done" }],
    });
    const node = workflow.nodes[0] as { stack?: boolean; branch?: string };
    expect(node.stack).toBe(true);
    expect(node.branch).toBe("feat/release");
  });

  test("rejects a non-boolean stack", () => {
    expect(() =>
      fromObject({
        id: "x",
        name: "X",
        version: 1,
        scope: { type: "project" },
        trigger: { type: "manual" },
        nodes: [
          { id: "drive", type: "agent_task", prompt: "drive", adopt: true, stack: "yes" },
          { id: "done", type: "finish" },
        ],
        edges: [{ from: "drive", to: "done" }],
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

describe("script node", () => {
  const withScript = (script: Record<string, unknown>) => ({
    ...MINIMAL,
    nodes: [
      { id: "lint", type: "script", ...script },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "lint", to: "done" }],
  });

  test("round-trips command, workdir, timeout, and env allowlist", () => {
    const { workflow } = fromObject(
      withScript({
        command: "bun run lint",
        workdir: "/srv/projects/foo",
        timeout_seconds: 120,
        env: ["PATH", "HOME"],
      }),
    );
    const reparsed = parseWorkflow(serializeWorkflow(workflow)).workflow;
    const node = reparsed.nodes.find((n) => n.id === "lint") as ScriptNode;
    expect(node.type).toBe("script");
    expect(node.command).toBe("bun run lint");
    expect(node.workdir).toBe("/srv/projects/foo");
    expect(node.timeout_seconds).toBe(120);
    expect(node.env).toEqual(["PATH", "HOME"]);
  });

  test("a command is the only required field", () => {
    const { workflow } = fromObject(withScript({ command: "make test" }));
    const node = workflow.nodes.find((n) => n.id === "lint") as ScriptNode;
    expect(node.command).toBe("make test");
    expect(node.workdir).toBeUndefined();
    expect(node.env).toBeUndefined();
  });

  test("rejects a script node without a command", () => {
    expect(() => fromObject(withScript({ workdir: "/tmp" }))).toThrow(WorkflowParseError);
  });

  test("rejects a non-string command", () => {
    expect(() => fromObject(withScript({ command: 42 }))).toThrow(WorkflowParseError);
  });

  test("rejects a non-list env", () => {
    expect(() => fromObject(withScript({ command: "ls", env: "PATH" }))).toThrow(
      WorkflowParseError,
    );
  });

  test("rejects a non-string env entry", () => {
    expect(() => fromObject(withScript({ command: "ls", env: ["PATH", 7] }))).toThrow(
      WorkflowParseError,
    );
  });
});
