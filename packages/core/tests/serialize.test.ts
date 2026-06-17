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

  test("round-trips a prompt node (with text and bare)", () => {
    const wf = fromObject({
      id: "pn",
      name: "PN",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes: [
        { id: "p", type: "prompt", prompt: "primary instruction" },
        { id: "bare", type: "prompt" },
        { id: "a", type: "agent_task", prompt: "work", profile: "x" },
        { id: "done", type: "finish" },
      ],
      edges: [
        { from: "p", to: "a" },
        { from: "bare", to: "a" },
        { from: "a", to: "done" },
      ],
    }).workflow;
    const round = parseWorkflow(serializeWorkflow(wf));
    expect(round.workflow).toEqual(wf);
  });

  test("round-trips an agent_task board flag (off-board and explicit on-board)", () => {
    const wf = fromObject({
      id: "ob",
      name: "OB",
      version: 1,
      scope: { type: "project" },
      trigger: { type: "manual" },
      defaults: { profile: "p" },
      nodes: [
        { id: "internal", type: "agent_task", prompt: "orchestrate", board: false },
        { id: "onboard", type: "agent_task", prompt: "work", board: true },
        { id: "done", type: "finish" },
      ],
      edges: [
        { from: "internal", to: "onboard" },
        { from: "onboard", to: "done" },
      ],
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

  function wfWithPrompt(prompt: string) {
    return fromObject({
      id: "b",
      name: "B",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes: [
        { id: "a", type: "agent_task", prompt, profile: "x" },
        { id: "done", type: "finish" },
      ],
      edges: [{ from: "a", to: "done" }],
    }).workflow;
  }

  test("emits a multiline string as a readable block scalar", () => {
    const wf = wfWithPrompt("First line.\nSecond line.\nThird.\n");
    const text = serializeWorkflow(wf);
    // Human-readable block scalar, not a one-line quoted "...\n..." string.
    expect(text).toContain('"prompt": |');
    expect(text).toContain("    First line.");
    expect(text).not.toContain('"First line.\\nSecond line.');
    // And it still round-trips exactly.
    expect(parseWorkflow(text).workflow).toEqual(wf);
  });

  test("uses the strip indicator for a multiline string with no trailing newline", () => {
    const wf = wfWithPrompt("alpha\nbeta");
    const text = serializeWorkflow(wf);
    expect(text).toContain('"prompt": |-');
    expect(parseWorkflow(text).workflow).toEqual(wf);
  });

  test("round-trips multiline strings with blank interior lines", () => {
    const wf = wfWithPrompt("para one\n\npara two\n");
    const text = serializeWorkflow(wf);
    expect(parseWorkflow(text).workflow).toEqual(wf);
  });

  test("falls back to a quoted scalar when a block scalar would be lossy", () => {
    // A trailing space on a content line cannot survive a block scalar, and a
    // 2+ trailing-newline string is ambiguous to clip/strip - both keep quoting.
    for (const prompt of ["has trailing space \nnext line\n", "double\n\n", " leading\nspace\n"]) {
      const wf = wfWithPrompt(prompt);
      const text = serializeWorkflow(wf);
      expect(parseWorkflow(text).workflow).toEqual(wf);
    }
  });

  test("keeps single-line strings as quoted scalars", () => {
    const wf = wfWithPrompt("just one line");
    expect(serializeWorkflow(wf)).toContain('"prompt": "just one line"');
  });

  test("round-trips the notifications.subscribe_cards opt-out", () => {
    const wf = fromObject({
      id: "n",
      name: "N",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      notifications: { subscribe_cards: false },
      nodes: [{ id: "done", type: "finish" }],
      edges: [],
    }).workflow;
    const round = parseWorkflow(serializeWorkflow(wf)).workflow;
    expect(round).toEqual(wf);
    expect(round.notifications?.subscribe_cards).toBe(false);
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
