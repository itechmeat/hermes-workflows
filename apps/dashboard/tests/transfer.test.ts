import { describe, it, expect } from "vitest";
import { parseWorkflowJsonFile, workflowJsonFile } from "../src/templates/transfer";
import type { SpecDetail, Workflow, UiLayout } from "../src/api/types";

const workflow = {
  id: "deploy",
  name: "Deploy Pipeline",
  version: 1,
  scope: { type: "global" },
  trigger: { type: "manual" },
  nodes: [{ id: "done", type: "finish" }],
  edges: [],
} as unknown as Workflow;

const ui: UiLayout = {
  xyflow: { nodes: [{ id: "done", x: 10, y: 20 }], viewport: { x: 0, y: 0, zoom: 1 } },
};

const detail: SpecDetail = { workflow, ui, path: "/srv/specs/deploy.workflow.yaml" };

describe("workflowJsonFile", () => {
  it("names the file after the workflow id, on-disk style", () => {
    expect(workflowJsonFile(detail).filename).toBe("deploy.workflow.json");
  });

  it("serializes the authoring shape — workflow + ui, never path", () => {
    const parsed = JSON.parse(workflowJsonFile(detail).content);
    expect(parsed).toEqual({ workflow, ui });
    expect("path" in parsed).toBe(false);
  });

  it("omits ui entirely when the spec has none", () => {
    const parsed = JSON.parse(workflowJsonFile({ workflow, path: detail.path }).content);
    expect(parsed).toEqual({ workflow });
    expect("ui" in parsed).toBe(false);
  });

  it("pretty-prints with a trailing newline (diff- and editor-friendly)", () => {
    const { content } = workflowJsonFile(detail);
    expect(content).toBe(`${JSON.stringify({ workflow, ui }, null, 2)}\n`);
  });
});

describe("parseWorkflowJsonFile", () => {
  it("round-trips an exported file back to the create body", () => {
    expect(parseWorkflowJsonFile(workflowJsonFile(detail).content)).toEqual({ workflow, ui });
  });

  it("returns a body without ui when the file has none", () => {
    const body = parseWorkflowJsonFile(JSON.stringify({ workflow }));
    expect(body).toEqual({ workflow });
    expect("ui" in body).toBe(false);
  });

  it("rejects malformed JSON with an explicit message", () => {
    expect(() => parseWorkflowJsonFile("{nope")).toThrow(/not valid JSON/i);
  });

  it("rejects JSON that is not a workflow export", () => {
    for (const text of [
      "[]",
      '"string"',
      "{}",
      JSON.stringify({ workflow: "not-an-object" }),
      JSON.stringify({ workflow: { name: "no id" } }),
      JSON.stringify({ workflow: { id: 42 } }),
    ]) {
      expect(() => parseWorkflowJsonFile(text)).toThrow(/not a workflow JSON export/i);
    }
  });
});
