import { describe, it, expect } from "vitest";
import {
  describeImportNormalization,
  modelKeySet,
  normalizeWorkflowForImport,
  type ImportCatalog,
} from "../src/templates/normalizeImport";
import type { CreateWorkflowBody } from "../src/api/types";
import type { AgentTaskNode } from "@hermes-workflows/core/schema/nodes.ts";

/** Narrow the first node to an agent_task (the fixtures put it at index 0). */
function firstAgent(b: CreateWorkflowBody): AgentTaskNode {
  const node = b.workflow.nodes[0];
  if (node?.type !== "agent_task") throw new Error("expected an agent_task node at index 0");
  return node;
}

function body(nodes: unknown[]): CreateWorkflowBody {
  return {
    workflow: {
      id: "wf",
      name: "WF",
      version: 1,
      scope: { type: "global" },
      trigger: { type: "manual" },
      nodes,
      edges: [],
    },
  } as unknown as CreateWorkflowBody;
}

const fullCatalog: ImportCatalog = {
  models: new Set(["gpt-4o@openai"]),
  profiles: new Set(["known-agent"]),
  skills: new Set(["known-skill"]),
};

describe("modelKeySet", () => {
  it("builds model@provider keys across providers", () => {
    expect(
      modelKeySet([
        { provider: "openai", label: "OpenAI", models: ["gpt-4o", "o3"] },
        { provider: "anthropic", label: "Anthropic", models: ["claude-opus-4-8"] },
      ]),
    ).toEqual(new Set(["gpt-4o@openai", "o3@openai", "claude-opus-4-8@anthropic"]));
  });
});

describe("normalizeWorkflowForImport", () => {
  it("drops an unknown model, profile, and unknown skills; keeps known ones", () => {
    const { body: out, resets } = normalizeWorkflowForImport(
      body([
        {
          id: "a",
          type: "agent_task",
          prompt: "x",
          model: "ghost@nowhere",
          profile: "missing",
          skills: ["known-skill", "ghost-skill"],
        },
        { id: "done", type: "finish" },
      ]),
      fullCatalog,
    );
    const node = firstAgent(out);
    expect(node.model).toBeUndefined();
    expect(node.profile).toBeUndefined();
    expect(node.skills).toEqual(["known-skill"]);
    expect(resets).toEqual([
      { node: "a", model: "ghost@nowhere", profile: "missing", droppedSkills: ["ghost-skill"] },
    ]);
  });

  it("keeps values that the host knows", () => {
    const { resets } = normalizeWorkflowForImport(
      body([
        {
          id: "a",
          type: "agent_task",
          prompt: "x",
          model: "gpt-4o@openai",
          profile: "known-agent",
          skills: ["known-skill"],
        },
        { id: "done", type: "finish" },
      ]),
      fullCatalog,
    );
    expect(resets).toEqual([]);
  });

  it("drops the skills field entirely when none survive", () => {
    const { body: out } = normalizeWorkflowForImport(
      body([
        { id: "a", type: "agent_task", prompt: "x", skills: ["ghost-skill"] },
        { id: "done", type: "finish" },
      ]),
      fullCatalog,
    );
    expect(firstAgent(out).skills).toBeUndefined();
  });

  it("leaves a field untouched when its dimension is unverified", () => {
    const {
      body: out,
      resets,
      unverified,
    } = normalizeWorkflowForImport(
      body([
        { id: "a", type: "agent_task", prompt: "x", model: "ghost@nowhere" },
        { id: "done", type: "finish" },
      ]),
      { profiles: new Set(), skills: new Set() }, // models unverified
    );
    expect(firstAgent(out).model).toBe("ghost@nowhere");
    expect(resets).toEqual([]);
    expect(unverified).toEqual(["models"]);
  });

  it("never touches non-agent_task nodes", () => {
    const input = body([
      { id: "s", type: "script", command: "make" },
      { id: "done", type: "finish" },
    ]);
    const { resets, unverified } = normalizeWorkflowForImport(input, {
      models: undefined,
      profiles: undefined,
      skills: undefined,
    });
    // No agent_task node, so an unverified catalogue is irrelevant — no noise.
    expect(resets).toEqual([]);
    expect(unverified).toEqual([]);
  });

  it("passes a body with no nodes array through untouched", () => {
    const input = { workflow: { id: "wf", name: "WF" } } as unknown as CreateWorkflowBody;
    const { body: out, resets } = normalizeWorkflowForImport(input, fullCatalog);
    expect(out).toBe(input);
    expect(resets).toEqual([]);
  });

  it("does not mutate the input body", () => {
    const input = body([
      { id: "a", type: "agent_task", prompt: "x", model: "ghost@nowhere" },
      { id: "done", type: "finish" },
    ]);
    normalizeWorkflowForImport(input, fullCatalog);
    expect(firstAgent(input).model).toBe("ghost@nowhere");
  });
});

describe("describeImportNormalization", () => {
  it("returns an empty string when nothing changed and all dimensions verified", () => {
    expect(describeImportNormalization([], [])).toBe("");
  });

  it("pluralises and joins resets plus unverified dimensions", () => {
    const msg = describeImportNormalization(
      [
        { node: "a", model: "m", droppedSkills: ["s1", "s2"] },
        { node: "b", profile: "p" },
      ],
      ["models"],
    );
    expect(msg).toBe(
      "reset unknown 1 model, 1 profile, 2 skills to defaults; could not verify models (left as-is)",
    );
  });
});
