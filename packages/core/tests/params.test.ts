import { describe, expect, test } from "bun:test";

import {
  paramFormSchema,
  paramSlashCommand,
  paramDeeplink,
  catalogEntry,
  agentSeed,
  fillParams,
  ParamFillError,
  fromObject,
  parseWorkflow,
  serializeWorkflow,
  compileToHermesPlan,
  validateWorkflow,
} from "../src/index.ts";
import type { WorkflowParam, WorkflowTemplate } from "../src/index.ts";

const PARAMS: WorkflowParam[] = [
  { name: "topic", type: "text", label: "Topic", default: "AI", help: "a subject" },
  { name: "count", type: "int", label: "How many?", default: 5 },
  { name: "tone", type: "enum", label: "Tone", default: "formal", options: ["formal", "casual"] },
  { name: "note", type: "text", label: "Note", optional: true },
];

const TEMPLATE: WorkflowTemplate = {
  key: "daily-digest",
  title: "Daily digest",
  description: "A recurring digest on a topic.",
  params: PARAMS,
};

describe("paramFormSchema", () => {
  test("emits one field per param with its descriptor", () => {
    const schema = paramFormSchema(PARAMS);
    expect(schema.map((f) => f.name)).toEqual(["topic", "count", "tone", "note"]);
    const tone = schema.find((f) => f.name === "tone");
    expect(tone).toMatchObject({ type: "enum", label: "Tone", default: "formal", optional: false });
    expect(tone?.options).toEqual(["formal", "casual"]);
  });
});

describe("paramSlashCommand", () => {
  test("builds /workflow <key> name=val with defaults, quoting text/spaces", () => {
    const cmd = paramSlashCommand("daily-digest", PARAMS);
    expect(cmd).toBe('/workflow daily-digest topic="AI" count=5 tone=formal');
  });

  test("uses supplied values and quotes spaces", () => {
    const cmd = paramSlashCommand("daily-digest", PARAMS, { topic: "machine learning", count: 3 });
    expect(cmd).toContain('topic="machine learning"');
    expect(cmd).toContain("count=3");
  });

  test("omits an optional param with no value", () => {
    expect(paramSlashCommand("daily-digest", PARAMS)).not.toContain("note=");
  });
});

describe("paramDeeplink", () => {
  test("builds a hermes://workflow/<key>?query deep-link", () => {
    const url = paramDeeplink("daily-digest", PARAMS, {
      topic: "ai safety",
      count: 3,
      tone: "casual",
    });
    expect(url.startsWith("hermes://workflow/daily-digest?")).toBe(true);
    expect(url).toContain("topic=ai%20safety");
    expect(url).toContain("count=3");
    expect(url).toContain("tone=casual");
  });
});

describe("catalogEntry", () => {
  test("bundles the form schema, slash command, and deep-link from one schema", () => {
    const entry = catalogEntry(TEMPLATE);
    expect(entry.key).toBe("daily-digest");
    expect(entry.title).toBe("Daily digest");
    expect(entry.fields.map((f) => f.name)).toEqual(["topic", "count", "tone", "note"]);
    expect(entry.command).toBe(paramSlashCommand("daily-digest", PARAMS));
    expect(entry.appUrl.startsWith("hermes://workflow/daily-digest")).toBe(true);
  });
});

describe("agentSeed", () => {
  test("asks for each param with its default and options", () => {
    const seed = agentSeed(TEMPLATE);
    expect(seed).toContain("daily-digest");
    expect(seed).toContain("Topic (topic)");
    expect(seed).toContain("formal, casual");
    expect(seed).toContain("[default: 5]");
    expect(seed).toContain("(optional)");
  });
});

describe("fillParams", () => {
  test("resolves defaults and supplied values", () => {
    const filled = fillParams(PARAMS, { topic: "robots" });
    expect(filled).toEqual({ topic: "robots", count: 5, tone: "formal" });
  });

  test("rejects an unknown param (a typo must not silently use the default)", () => {
    expect(() => fillParams(PARAMS, { tpoic: "x" })).toThrow(ParamFillError);
  });

  test("rejects a missing required param", () => {
    const required: WorkflowParam[] = [{ name: "topic", type: "text", label: "Topic" }];
    expect(() => fillParams(required, {})).toThrow(ParamFillError);
  });

  test("the missing-required error names the param and its label", () => {
    const required: WorkflowParam[] = [
      { name: "feature_request", type: "text", label: "Feature request" },
    ];
    expect(() => fillParams(required, {})).toThrow(
      "missing required value: feature_request (Feature request)",
    );
  });

  test("a required param with no default is not satisfied by a blank value", () => {
    const required: WorkflowParam[] = [
      { name: "feature_request", type: "text", label: "Feature request" },
    ];
    expect(() => fillParams(required, { feature_request: "" })).toThrow(ParamFillError);
  });

  test("rejects an out-of-options strict enum", () => {
    expect(() => fillParams(PARAMS, { tone: "angry" })).toThrow(ParamFillError);
  });

  test("accepts any value for a non-strict enum (validated downstream)", () => {
    const open: WorkflowParam[] = [
      {
        name: "deliver",
        type: "enum",
        label: "Deliver",
        options: ["origin"],
        strict: false,
        default: "origin",
      },
    ];
    expect(fillParams(open, { deliver: "telegram:1:2" })).toEqual({ deliver: "telegram:1:2" });
  });

  test("rejects a non-integer int and a non-boolean bool", () => {
    expect(() => fillParams([{ name: "n", type: "int", label: "N" }], { n: "x" })).toThrow(
      ParamFillError,
    );
    // A boolean must not silently coerce to 0/1 for an int param.
    expect(() => fillParams([{ name: "n", type: "int", label: "N" }], { n: true })).toThrow(
      ParamFillError,
    );
    expect(() => fillParams([{ name: "b", type: "bool", label: "B" }], { b: "maybe" })).toThrow(
      ParamFillError,
    );
  });
});

describe("workflow.params schema", () => {
  function build(params: unknown): ReturnType<typeof fromObject>["workflow"] {
    return fromObject({
      id: "tmpl",
      name: "Tmpl",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      defaults: { profile: "p" },
      params,
      nodes: [
        { id: "a", type: "agent_task", prompt: "{{params.topic}}", profile: "p" },
        { id: "done", type: "finish" },
      ],
      edges: [{ from: "a", to: "done" }],
    }).workflow;
  }

  const VALID: unknown = [
    { name: "topic", type: "text", label: "Topic", default: "AI" },
    { name: "tone", type: "enum", label: "Tone", options: ["formal", "casual"], default: "formal" },
  ];

  test("parses params off the spec", () => {
    expect(build(VALID).params?.map((p) => p.name)).toEqual(["topic", "tone"]);
  });

  test("round-trips through serialize", () => {
    const w = build(VALID);
    expect(parseWorkflow(serializeWorkflow(w)).workflow.params).toEqual(w.params);
  });

  test("rejects an unknown param type at parse", () => {
    expect(() => build([{ name: "x", type: "date", label: "X" }])).toThrow();
  });

  test("maps required: true to a required param (optional false)", () => {
    const params = build([{ name: "x", type: "text", label: "X", required: true }]).params;
    expect(params?.[0]).toMatchObject({ name: "x", optional: false });
  });

  test("maps required: false to an optional param", () => {
    const params = build([{ name: "x", type: "text", label: "X", required: false }]).params;
    expect(params?.[0]).toMatchObject({ name: "x", optional: true });
  });

  test("rejects a param declaring both optional and required", () => {
    expect(() =>
      build([{ name: "x", type: "text", label: "X", optional: true, required: true }]),
    ).toThrow();
  });

  test("rejects a non-boolean required", () => {
    expect(() => build([{ name: "x", type: "text", label: "X", required: "yes" }])).toThrow();
  });

  test("rejects options on a non-enum param", () => {
    expect(() => build([{ name: "n", type: "int", label: "N", options: ["1"] }])).toThrow();
  });

  test("rejects a default whose type does not match the param type", () => {
    expect(() => build([{ name: "n", type: "int", label: "N", default: "abc" }])).toThrow();
    expect(() => build([{ name: "b", type: "bool", label: "B", default: "yes" }])).toThrow();
    expect(() => build([{ name: "t", type: "text", label: "T", default: 5 }])).toThrow();
  });

  test("rejects a strict enum default that is not one of its options", () => {
    expect(() =>
      build([{ name: "tone", type: "enum", label: "Tone", options: ["a", "b"], default: "c" }]),
    ).toThrow();
  });

  test("flags duplicate param names", () => {
    const wf = build([
      { name: "a", type: "text", label: "A" },
      { name: "a", type: "text", label: "A2" },
    ]);
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "duplicate_param")).toBe(true);
  });

  test("compile-preview surfaces params and a catalog entry", () => {
    const plan = compileToHermesPlan(build(VALID));
    expect(plan.params?.map((p) => p.name)).toEqual(["topic", "tone"]);
    expect(plan.catalog?.command).toContain("/workflow tmpl");
    expect(plan.catalog?.appUrl.startsWith("hermes://workflow/tmpl")).toBe(true);
  });

  test("a workflow without params has no catalog in the plan", () => {
    const plan = compileToHermesPlan(build(undefined));
    expect(plan.params).toBeUndefined();
    expect(plan.catalog).toBeUndefined();
  });
});
