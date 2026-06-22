import { describe, expect, test } from "bun:test";

import {
  parseWorkflow,
  specSha,
  exportTemplate,
  templateCacheKey,
  templateRevision,
  generationRequest,
  TEMPLATE_FORMAT,
  GENERATOR_VERSION,
} from "../src/index.ts";
import type { Workflow } from "../src/index.ts";
import { loadExample } from "./_fixtures.ts";

const AT = "2026-06-22T12:00:00.000Z";

async function feature(): Promise<Workflow> {
  return (await loadExample("feature-development.workflow.yaml")).workflow;
}

describe("exportTemplate — de-binding", () => {
  test("replaces concrete project/profile/model/deliver with ${...} placeholders; YAML still parses", async () => {
    const workflow = await feature();
    workflow.scope = { type: "projects", projects: ["my-real-project"] };
    workflow.deliver = "telegram:-1003895040510:161";
    workflow.defaults = { ...workflow.defaults, profile: "fullstack-engineer" };

    const bundle = exportTemplate(workflow, { generatedAt: AT });
    const yaml = bundle.templateYaml;

    // No concrete bound values survive.
    expect(yaml).not.toContain("my-real-project");
    expect(yaml).not.toContain("telegram:-1003895040510:161");
    expect(yaml).not.toContain("fullstack-engineer");
    expect(yaml).not.toContain("product-tech-lead");
    expect(yaml).not.toContain("qa-engineer");

    // Placeholders are present.
    expect(yaml).toContain("${PROJECT}");
    expect(yaml).toContain("${DELIVER_TARGET}");
    expect(yaml).toMatch(/\$\{PROFILE:/);

    // The de-bound YAML still parses structurally (the template: block is ignored
    // by the loader as an unknown top-level key).
    const reparsed = parseWorkflow(yaml);
    expect(reparsed.workflow.id).toBe(workflow.id);
    expect(reparsed.workflow.nodes.length).toBe(workflow.nodes.length);
  });

  test("strips the @provider suffix from a model into a single ${MODEL} placeholder", async () => {
    const workflow = await feature();
    workflow.defaults = { ...workflow.defaults, model: "qwen3.6-plus@opencode-go" };
    const bundle = exportTemplate(workflow, { generatedAt: AT });
    expect(bundle.templateYaml).not.toContain("opencode-go");
    expect(bundle.templateYaml).not.toContain("qwen3.6-plus");
    expect(bundle.templateYaml).toMatch(/\$\{MODEL:/);
    expect(bundle.placeholders.some((p) => p.kind === "model")).toBe(true);
  });

  test("tokenises a literal task_ref and workdir but keeps {{nodes.*}} references intact", async () => {
    const workflow = await feature();
    const node = workflow.nodes.find((n) => n.id === "implement");
    if (node?.type === "agent_task") {
      node.adopt = true;
      node.task_ref = "t_abc12345";
      node.workdir = "/srv/projects/my-real-project";
    }
    const other = workflow.nodes.find((n) => n.id === "plan");
    if (other?.type === "agent_task") {
      other.adopt = true;
      other.task_ref = "{{nodes.upstream.output.task_ids}}";
    }
    const bundle = exportTemplate(workflow, { generatedAt: AT });
    expect(bundle.templateYaml).not.toContain("t_abc12345");
    expect(bundle.templateYaml).not.toContain("/srv/projects/my-real-project");
    expect(bundle.templateYaml).toContain("${TASK_REF}");
    expect(bundle.templateYaml).toContain("${WORKDIR}");
    // The intra-workflow reference is portable and must survive verbatim.
    expect(bundle.templateYaml).toContain("{{nodes.upstream.output.task_ids}}");
  });
});

describe("exportTemplate — inventory scan (prompt bodies NOT rewritten)", () => {
  test("inventories installation-specific references in prompt/command bodies without editing them", async () => {
    const workflow = await feature();
    const node = workflow.nodes.find((n) => n.id === "implement");
    if (node?.type === "agent_task") {
      node.prompt =
        "Clone github.com/acme/widgets, build under /srv/projects/widgets, " +
        "then run `hermes kanban complete t_x`. Notify telegram:-1009999:7.";
    }
    const bundle = exportTemplate(workflow, { generatedAt: AT });

    // The prose is preserved verbatim (no rewriting).
    expect(bundle.templateYaml).toContain("/srv/projects/widgets");
    expect(bundle.templateYaml).toContain("github.com/acme/widgets");

    const kinds = new Set(bundle.inventory.map((i) => i.kind));
    expect(kinds.has("path")).toBe(true);
    expect(kinds.has("repo")).toBe(true);
    expect(kinds.has("channel")).toBe(true);
    expect(bundle.inventory.every((i) => i.nodeId === "implement")).toBe(true);
  });
});

describe("exportTemplate — versioning block", () => {
  test("emits a template: block with three independent version axes and a human string", async () => {
    const workflow = await feature();
    const bundle = exportTemplate(workflow, { generatedAt: AT, model: "qwen3.6-plus@opencode-go" });

    expect(bundle.version.template_format).toBe(TEMPLATE_FORMAT);
    expect(bundle.version.source.workflow_id).toBe(workflow.id);
    expect(bundle.version.source.workflow_version).toBe(workflow.version);
    expect(bundle.version.source.spec_sha).toBe(specSha(workflow));
    expect(bundle.version.generation.generator_version).toBe(GENERATOR_VERSION);
    expect(bundle.version.generation.model).toBe("qwen3.6-plus@opencode-go");
    expect(bundle.version.generation.generated_at).toBe(AT);
    expect(bundle.version.human_version).toMatch(
      new RegExp(`^fmt${TEMPLATE_FORMAT}·wf${workflow.version}·r[0-9a-f]{4,}$`),
    );

    // The block is serialized into the YAML (the emitter JSON-quotes keys, the
    // repo's established spec style) and the unknown top-level key is ignored on
    // re-parse, so the document still loads as a workflow.
    expect(bundle.templateYaml).toContain('"template"');
    expect(bundle.templateYaml).toContain("template_format");
    expect(bundle.templateYaml).toContain("spec_sha");
    expect(() => parseWorkflow(bundle.templateYaml)).not.toThrow();
  });

  test("revision changes only when a cache-key component changes", async () => {
    const workflow = await feature();
    const sha = specSha(workflow);
    const base = templateRevision(templateCacheKey(workflow.id, sha, TEMPLATE_FORMAT, GENERATOR_VERSION));

    // Same composite → same revision.
    expect(
      templateRevision(templateCacheKey(workflow.id, sha, TEMPLATE_FORMAT, GENERATOR_VERSION)),
    ).toBe(base);
    // Bumped generator → different revision.
    expect(
      templateRevision(templateCacheKey(workflow.id, sha, TEMPLATE_FORMAT, GENERATOR_VERSION + 1)),
    ).not.toBe(base);
    // Changed spec_sha → different revision.
    expect(
      templateRevision(templateCacheKey(workflow.id, "sha256:deadbeef", TEMPLATE_FORMAT, GENERATOR_VERSION)),
    ).not.toBe(base);
  });
});

describe("exportTemplate — adaptation guide (.template.md)", () => {
  test("opens with the PREREQUISITES block: REQUIRED hermes-workflows + RECOMMENDED o2b, with llms.txt links", async () => {
    const workflow = await feature();
    const md = exportTemplate(workflow, { generatedAt: AT }).guideMarkdown;

    const prereqIdx = md.indexOf("Prerequisites");
    const placeholderIdx = md.search(/placeholder/i);
    expect(prereqIdx).toBeGreaterThanOrEqual(0);
    // Prerequisites come before per-placeholder content.
    expect(prereqIdx).toBeLessThan(placeholderIdx);

    expect(md).toMatch(/REQUIRED/);
    expect(md).toContain("hermes-workflows");
    expect(md).toMatch(/RECOMMENDED/);
    expect(md.toLowerCase()).toContain("o2b");
    // Two llms.txt links present (case-insensitive).
    expect(md.match(/llms\.txt/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Human version stamped in the header.
    expect(md).toContain("fmt");
  });

  test("lists per-placeholder recommendations and the in-prompt-reference inventory", async () => {
    const workflow = await feature();
    const node = workflow.nodes.find((n) => n.id === "implement");
    if (node?.type === "agent_task") node.prompt = "Work under /srv/projects/widgets.";
    const bundle = exportTemplate(workflow, { generatedAt: AT });
    const md = bundle.guideMarkdown;

    // Every placeholder token shows up in the guide.
    for (const p of bundle.placeholders) {
      expect(md).toContain(p.token);
    }
    // The inventory item appears as an "adapt" entry.
    expect(md).toContain("/srv/projects/widgets");
  });

  test("uses AI hints when provided, deterministic fallback otherwise", async () => {
    const workflow = await feature();
    const withHints = exportTemplate(workflow, {
      generatedAt: AT,
      model: "m",
      hints: {
        overview: "A custom AI overview sentence.",
        nodes: [{ nodeId: "plan", role: "seasoned planner", capability: "strong reasoning" }],
      },
    });
    expect(withHints.guideMarkdown).toContain("seasoned planner");
    expect(withHints.guideMarkdown).toContain("strong reasoning");
    // The profile placeholder for `plan` carries the AI role hint.
    const planProfile = withHints.placeholders.find(
      (p) => p.nodeId === "plan" && p.kind === "profile",
    );
    expect(planProfile?.token).toContain("seasoned planner");

    // No hints → still produces a guide (fail-open), with a deterministic hint.
    const noHints = exportTemplate(workflow, { generatedAt: AT });
    expect(noHints.guideMarkdown).toMatch(/Prerequisites/);
  });
});

describe("generationRequest", () => {
  test("describes each node's purpose for the AI hint generator", async () => {
    const workflow = await feature();
    const req = generationRequest(workflow);
    expect(req.workflow_id).toBe(workflow.id);
    expect(req.spec_sha).toBe(specSha(workflow));
    const planNode = req.nodes.find((n: { id: string }) => n.id === "plan");
    expect(planNode?.title).toBe("Plan feature");
    expect(planNode?.prompt).toContain("implementation plan");
  });
});

describe("cache key", () => {
  test("is stable for identical inputs and sensitive to each component", () => {
    const k = templateCacheKey("wf", "sha256:aa", 1, 1);
    expect(templateCacheKey("wf", "sha256:aa", 1, 1)).toBe(k);
    expect(templateCacheKey("wf2", "sha256:aa", 1, 1)).not.toBe(k);
    expect(templateCacheKey("wf", "sha256:bb", 1, 1)).not.toBe(k);
    expect(templateCacheKey("wf", "sha256:aa", 2, 1)).not.toBe(k);
    expect(templateCacheKey("wf", "sha256:aa", 1, 2)).not.toBe(k);
  });
});
