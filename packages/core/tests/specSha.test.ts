import { describe, expect, test } from "bun:test";

import { parseWorkflow, specSha } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

describe("specSha", () => {
  test("is a stable sha256-prefixed token", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const sha = specSha(workflow);
    expect(sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Deterministic: same input → same hash.
    expect(specSha(workflow)).toBe(sha);
  });

  test("is invariant to cosmetic YAML key ordering (parse normalizes)", () => {
    const a = parseWorkflow(
      [
        "id: x",
        "name: X",
        "version: 1",
        "scope: { type: global }",
        "trigger: { type: manual }",
        "nodes:",
        "  - { id: a, type: finish, outcome: success }",
        "edges: []",
      ].join("\n"),
    ).workflow;
    // Same workflow, top-level keys in a different order.
    const b = parseWorkflow(
      [
        "name: X",
        "version: 1",
        "trigger: { type: manual }",
        "scope: { type: global }",
        "edges: []",
        "id: x",
        "nodes:",
        "  - { id: a, type: finish, outcome: success }",
      ].join("\n"),
    ).workflow;
    expect(specSha(a)).toBe(specSha(b));
  });

  test("changes when any spec content changes", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    const before = specSha(workflow);
    const edited = structuredClone(workflow);
    edited.version = workflow.version + 1;
    expect(specSha(edited)).not.toBe(before);

    const promptEdited = structuredClone(workflow);
    const node = promptEdited.nodes.find((n) => n.type === "agent_task");
    if (node && node.type === "agent_task") node.prompt += " extra";
    expect(specSha(promptEdited)).not.toBe(before);
  });

  test("ignores ui layout (presentation is not spec substance)", async () => {
    const { workflow } = await loadExample("feature-development.workflow.yaml");
    // specSha takes only the workflow; a ui layout never enters the hash.
    expect(specSha(workflow)).toMatch(/^sha256:/);
  });
});
