import { describe, expect, test } from "bun:test";

import { parseWorkflow, fromObject, serializeWorkflow } from "../src/index.ts";
import type { UiLayout } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

const EXAMPLES = ["feature-development.workflow.yaml", "blog-daily-signals.workflow.yaml"];

describe("serializeWorkflow", () => {
  for (const name of EXAMPLES) {
    test(`round-trips ${name} losslessly`, async () => {
      const original = await loadExample(name);
      const reparsed = parseWorkflow(serializeWorkflow(original.workflow, original.ui));
      expect(reparsed).toEqual(original);
    });
  }

  test("preserves a multiline prompt across the round trip", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const round = parseWorkflow(serializeWorkflow(workflow));
    const before = workflow.nodes.find((n) => n.type === "agent_task");
    const after = round.workflow.nodes.find((n) => n.type === "agent_task");
    expect(after).toEqual(before);
    if (before?.type === "agent_task") expect(before.prompt).toContain("\n");
  });

  test("omits the ui block when there is no layout", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    expect(serializeWorkflow(workflow)).not.toContain("ui:");
  });

  test("round-trips an attached ui layout", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const ui: UiLayout = {
      xyflow: {
        nodes: [
          { id: "plan", x: 100, y: 50 },
          { id: "done", x: 400, y: 50 },
        ],
        viewport: { x: 0, y: 0, zoom: 1.25 },
      },
    };
    const round = parseWorkflow(serializeWorkflow(workflow, ui));
    expect(round.workflow).toEqual(workflow);
    expect(round.ui).toEqual(ui);
  });

  test("round-trips agent_task input_mapping keys that need escaping", () => {
    const wf = fromObject({
      id: "keys",
      name: "Keys",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes: [
        {
          id: "a",
          type: "agent_task",
          prompt: "p",
          profile: "x",
          input_mapping: { "weird: key #c": "v1", "line\nbreak": "v2", "": "empty" },
        },
        { id: "done", type: "finish" },
      ],
      edges: [{ from: "a", to: "done" }],
    }).workflow;
    const round = parseWorkflow(serializeWorkflow(wf));
    expect(round.workflow).toEqual(wf);
  });

  test("round-trips the enabled flag", () => {
    for (const enabled of [true, false] as const) {
      const wf = fromObject({
        id: "e",
        name: "E",
        version: 1,
        enabled,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "done", type: "finish" }],
        edges: [],
      }).workflow;
      expect(parseWorkflow(serializeWorkflow(wf)).workflow).toEqual(wf);
    }
  });

  test("emits valid YAML that re-parses", () => {
    const { workflow, ui } = parseWorkflow(
      [
        "id: tiny",
        "name: Tiny",
        "version: 1",
        "scope: { type: global }",
        "trigger: { type: manual }",
        "nodes: [{ id: done, type: finish }]",
        "edges: []",
      ].join("\n"),
    );
    const text = serializeWorkflow(workflow, ui);
    expect(() => parseWorkflow(text)).not.toThrow();
  });
});
