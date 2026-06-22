/**
 * Export a workflow "as a template": decouple it from this installation so it
 * can be shared publicly and instantiated by anyone on their own Hermes.
 *
 * Two artifacts are produced from one source workflow:
 *   - `<id>.template.yaml` — the workflow with installation-specific *structured
 *     bindings* rewritten into self-documenting `${...}` placeholders, plus a
 *     `template:` provenance/version block. The de-bound YAML still parses as a
 *     workflow (the loader ignores the unknown `template:` top-level key).
 *   - `<id>.template.md` — an adaptation guide (an llms.txt analog) opening with
 *     a PREREQUISITES block, then per-placeholder recommendations and an
 *     inventory of installation-specific references still present in prompt
 *     bodies (which are deliberately NOT rewritten).
 *
 * Two halves, by design:
 *   1. DETERMINISTIC de-binding + inventory + versioning — pure, no model. This
 *      is everything in this file.
 *   2. AI hints (free-form role/capability per node, derived from each node's
 *      purpose) + guide prose — generated once by the default model on the
 *      Python side and passed in as `opts.hints`. Absent hints degrade to a
 *      deterministic fallback (fail-open), so the export never *requires* a
 *      model.
 *
 * Versioning lives along three independent axes (see {@link TemplateVersion})
 * and the cache/regeneration key is the composite
 * `(workflow_id, spec_sha, template_format, generator_version)`; the short
 * `revision` is a deterministic hash of that composite — it changes exactly
 * when a regeneration is warranted.
 */

import { createHash } from "node:crypto";
import type { Workflow } from "../schema/workflow.ts";
import type { WorkflowNode, AgentTaskNode } from "../schema/nodes.ts";
import { serializeWorkflow } from "../serialize/serializeWorkflow.ts";
import { specSha } from "../serialize/specSha.ts";

/** Schema version of the template ARTIFACT (placeholder syntax, params shape,
 * guide structure, prerequisites block). Bump ONLY when the format changes; a
 * consuming hermes-workflows plugin declares which value it can read. */
export const TEMPLATE_FORMAT = 1;

/** Version of the AI generator (extraction rules + prompt + model contract).
 * Bump when generation logic improves so a template can be regenerated even
 * when the source workflow is unchanged. */
export const GENERATOR_VERSION = 1;

/** Minimum plugin version that can read `template_format: 1` (stated in the
 * guide's prerequisites block as the compatibility contract). */
const MIN_PLUGIN_VERSION = "0.6.0";

/** Prerequisite links surfaced in the guide. Overridable so a distribution can
 * point at its own canonical URLs; the defaults reference each plugin's bundled
 * `LLMS.txt`. */
export interface PrereqLinks {
  workflowsLlms: string;
  o2bLlms: string;
}

const DEFAULT_PREREQ_LINKS: PrereqLinks = {
  workflowsLlms:
    "https://github.com/NousResearch/hermes-workflows/blob/main/LLMS.txt (bundled `LLMS.txt` at the plugin root)",
  o2bLlms:
    "https://github.com/NousResearch/open-second-brain/blob/main/LLMS.txt (bundled `LLMS.txt` at the plugin root)",
};

type PlaceholderKind = "project" | "profile" | "model" | "deliver" | "workdir" | "task_ref";

/** One rewritten binding site: a concrete installation value replaced by a
 * `${...}` placeholder token. */
export interface TemplatePlaceholder {
  token: string;
  kind: PlaceholderKind;
  /** Free-form hint (role for a profile, capability for a model). Absent for
   * value-only placeholders (project, deliver, workdir, task_ref). */
  hint?: string;
  /** Binding-site node id; absent for workflow-level bindings (scope/defaults/deliver). */
  nodeId?: string;
  /** Where in the spec the binding lived, e.g. `defaults.profile`, `node.model`. */
  field: string;
  /** The concrete value that was replaced (provenance / guide context). */
  original: string;
}

/** A reference to this installation found INSIDE a prose body (prompt, command,
 * title, description). Reported in the guide for the adapter to edit by hand —
 * the body itself is never rewritten. */
export interface InventoryItem {
  nodeId: string;
  field: string;
  kind: "path" | "repo" | "channel" | "project_name" | "kanban_wrapper" | "url" | "branch" | "skill";
  match: string;
  note?: string;
}

/** The three independent version axes plus derived human-readable forms. */
export interface TemplateVersion {
  template_format: number;
  source: { workflow_id: string; workflow_version: number; spec_sha: string };
  generation: { generator_version: number; model: string | null; generated_at: string };
  /** Short deterministic hash of the composite cache key. */
  revision: string;
  /** `fmt<format>·wf<workflow_version>·r<revision-short>`. */
  human_version: string;
}

/** AI-generated, per-node free-form hints (optional). */
export interface NodeHint {
  nodeId: string;
  /** Recommended profile TYPE (free-form role), e.g. "experienced planner". */
  role?: string;
  /** Recommended model CAPABILITY class, e.g. "strong reasoning / long context". */
  capability?: string;
}

export interface GuideHints {
  /** A short prose overview of what the workflow does / how to adapt it. */
  overview?: string;
  nodes?: NodeHint[];
}

export interface ExportTemplateOptions {
  /** ISO timestamp stamped into `generation.generated_at`. Injected so the
   * function stays deterministic (no `Date.now()` inside core). */
  generatedAt: string;
  /** The model used to produce `hints`, or null/absent when none was used. */
  model?: string | null;
  /** AI-generated hints; absent → deterministic fallback hints. */
  hints?: GuideHints;
  templateFormat?: number;
  generatorVersion?: number;
  prereqLinks?: PrereqLinks;
}

export interface TemplateBundle {
  templateYaml: string;
  guideMarkdown: string;
  version: TemplateVersion;
  placeholders: TemplatePlaceholder[];
  inventory: InventoryItem[];
  specSha: string;
  cacheKey: string;
}

/** The deterministic description of a workflow's nodes the AI hint generator
 * consumes (built on the Python side into one default-model prompt). */
export interface GenerationRequest {
  workflow_id: string;
  spec_sha: string;
  nodes: {
    id: string;
    type: string;
    title?: string;
    description?: string;
    prompt?: string;
    profile?: string;
    model?: string;
  }[];
}

/** Composite cache / regeneration key. Regenerate iff any component changed. */
export function templateCacheKey(
  workflowId: string,
  specShaValue: string,
  templateFormat: number,
  generatorVersion: number,
): string {
  return [workflowId, specShaValue, `fmt${templateFormat}`, `gen${generatorVersion}`].join("|");
}

/** Short deterministic hash of a cache key — changes exactly when a
 * regeneration is warranted. */
export function templateRevision(cacheKey: string): string {
  return createHash("sha256").update(cacheKey, "utf8").digest("hex").slice(0, 8);
}

/** Describe each node's purpose for the AI hint generator (pure). */
export function generationRequest(workflow: Workflow): GenerationRequest {
  return {
    workflow_id: workflow.id,
    spec_sha: specSha(workflow),
    nodes: workflow.nodes.map((node) => {
      const out: GenerationRequest["nodes"][number] = { id: node.id, type: node.type };
      if (node.title !== undefined) out.title = node.title;
      if (node.description !== undefined) out.description = node.description;
      if (node.type === "agent_task") {
        out.prompt = node.prompt;
        if (node.profile !== undefined) out.profile = node.profile;
        if (node.model !== undefined) out.model = node.model;
      } else if (node.type === "prompt" && node.prompt !== undefined) {
        out.prompt = node.prompt;
      } else if (node.type === "script") {
        out.prompt = node.command;
      }
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// Hint resolution (AI hint when present, deterministic fallback otherwise).
// ---------------------------------------------------------------------------

function humanizeId(id: string): string {
  return id.replace(/[_-]+/g, " ").trim();
}

function nodeLabel(node: WorkflowNode): string {
  return node.title ?? humanizeId(node.id);
}

function hintFor(hints: GuideHints | undefined, nodeId: string): NodeHint | undefined {
  return hints?.nodes?.find((n) => n.nodeId === nodeId);
}

/** Free-form recommended profile role for a node (AI hint or deterministic). */
function roleHint(node: WorkflowNode, hints: GuideHints | undefined): string {
  const ai = hintFor(hints, node.id)?.role;
  if (ai && ai.trim()) return ai.trim();
  return `a worker suited to "${nodeLabel(node)}"`;
}

/** Free-form recommended model capability for a node (AI hint or deterministic). */
function capabilityHint(node: WorkflowNode, hints: GuideHints | undefined): string {
  const ai = hintFor(hints, node.id)?.capability;
  if (ai && ai.trim()) return ai.trim();
  return `a model capable of "${nodeLabel(node)}"`;
}

// ---------------------------------------------------------------------------
// De-binding pass (structured fields → placeholders). Pure.
// ---------------------------------------------------------------------------

interface DebindResult {
  workflow: Workflow;
  placeholders: TemplatePlaceholder[];
}

/** Whether a value is an intra-workflow reference that must survive verbatim
 * (e.g. `{{nodes.x.output}}`) rather than an installation binding. */
function isPortableRef(value: string): boolean {
  return value.includes("{{");
}

function profileToken(hint: string): string {
  return `\${PROFILE:${hint}}`;
}

function modelToken(hint: string): string {
  return `\${MODEL:${hint}}`;
}

function debindWorkflow(workflow: Workflow, hints: GuideHints | undefined): DebindResult {
  const placeholders: TemplatePlaceholder[] = [];
  // Deep clone so the caller's workflow is untouched.
  const wf: Workflow = structuredClone(workflow);

  // scope.projects — distinct project ids map to ${PROJECT}, ${PROJECT_2}, …
  if (wf.scope.projects && wf.scope.projects.length > 0) {
    const seen = new Map<string, string>();
    wf.scope.projects = wf.scope.projects.map((proj) => {
      let token = seen.get(proj);
      if (!token) {
        token = seen.size === 0 ? "${PROJECT}" : `\${PROJECT_${seen.size + 1}}`;
        seen.set(proj, token);
        placeholders.push({
          token,
          kind: "project",
          field: "scope.projects",
          original: proj,
        });
      }
      return token;
    });
  }

  // defaults.profile / defaults.model (workflow-level).
  if (wf.defaults?.profile !== undefined) {
    const hint = "the workflow's default worker role";
    const token = profileToken(hint);
    placeholders.push({
      token,
      kind: "profile",
      hint,
      field: "defaults.profile",
      original: wf.defaults.profile,
    });
    wf.defaults.profile = token;
  }
  if (wf.defaults?.model !== undefined) {
    const hint = "the workflow's default model capability";
    const token = modelToken(hint);
    placeholders.push({
      token,
      kind: "model",
      hint,
      field: "defaults.model",
      original: wf.defaults.model,
    });
    wf.defaults.model = token;
  }

  // deliver target.
  if (wf.deliver !== undefined) {
    const token = "${DELIVER_TARGET}";
    placeholders.push({ token, kind: "deliver", field: "deliver", original: wf.deliver });
    wf.deliver = token;
  }

  // Per-node bindings.
  for (const node of wf.nodes) {
    if (node.type !== "agent_task") continue;
    debindAgentNode(node, hints, placeholders);
  }

  return { workflow: wf, placeholders };
}

function debindAgentNode(
  node: AgentTaskNode,
  hints: GuideHints | undefined,
  placeholders: TemplatePlaceholder[],
): void {
  if (node.profile !== undefined) {
    const hint = roleHint(node, hints);
    const token = profileToken(hint);
    placeholders.push({
      token,
      kind: "profile",
      hint,
      nodeId: node.id,
      field: "node.profile",
      original: node.profile,
    });
    node.profile = token;
  }
  if (node.model !== undefined) {
    const hint = capabilityHint(node, hints);
    const token = modelToken(hint);
    placeholders.push({
      token,
      kind: "model",
      hint,
      nodeId: node.id,
      field: "node.model",
      original: node.model,
    });
    node.model = token;
  }
  if (node.workdir !== undefined) {
    const token = "${WORKDIR}";
    placeholders.push({
      token,
      kind: "workdir",
      nodeId: node.id,
      field: "node.workdir",
      original: node.workdir,
    });
    node.workdir = token;
  }
  if (node.task_ref !== undefined && !isPortableRef(node.task_ref)) {
    const token = "${TASK_REF}";
    placeholders.push({
      token,
      kind: "task_ref",
      nodeId: node.id,
      field: "node.task_ref",
      original: node.task_ref,
    });
    node.task_ref = token;
  }
}

// ---------------------------------------------------------------------------
// Inventory scan (prose bodies are NOT rewritten; references are reported).
// ---------------------------------------------------------------------------

interface Detector {
  kind: InventoryItem["kind"];
  re: RegExp;
  note?: string;
}

const DETECTORS: Detector[] = [
  // The kanban wrapper invocation / hermes home — most specific first so a
  // `hermes kanban …` or `~/.hermes/…` reference is labelled as such rather
  // than a generic path.
  { kind: "kanban_wrapper", re: /hermes\s+kanban\b[^\n`'"]*/g, note: "the kanban wrapper invocation" },
  { kind: "kanban_wrapper", re: /~\/\.hermes\/[^\s"'`)]*/g, note: "a Hermes home path" },
  // GitHub repo references (URL or git remote).
  { kind: "repo", re: /github\.com[/:][\w.-]+\/[\w.-]+/g },
  { kind: "repo", re: /git@github\.com:[\w.-]+\/[\w.-]+/g },
  // Delivery / channel ids: platform:chat[:thread] and bare telegram supergroup ids.
  { kind: "channel", re: /\b(?:telegram|discord|slack|email):[\w:@.+-]+/gi },
  { kind: "channel", re: /-100\d{6,}/g, note: "a Telegram supergroup id" },
  // Absolute filesystem paths.
  { kind: "path", re: /\/(?:srv|root|tmp|usr|home|etc|opt|var)\/[^\s"'`)]*/g },
  // Bare URLs (last, so channel/repo win first).
  { kind: "url", re: /https?:\/\/[^\s"'`)]+/g },
];

function scanText(nodeId: string, field: string, text: string, into: InventoryItem[]): void {
  const claimed: Array<[number, number]> = [];
  for (const det of DETECTORS) {
    det.re.lastIndex = 0;
    for (const m of text.matchAll(det.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Skip a span already claimed by a more specific earlier detector.
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      into.push({ nodeId, field, kind: det.kind, match: m[0], ...(det.note ? { note: det.note } : {}) });
    }
  }
}

/** Scan all prose bodies for installation-specific references plus flag any
 * `skills`/`branch` fields (kept, not rewritten). */
function inventoryWorkflow(workflow: Workflow): InventoryItem[] {
  const items: InventoryItem[] = [];
  const projectIds = new Set(workflow.scope.projects ?? []);

  for (const node of workflow.nodes) {
    const fields: Array<[string, string | undefined]> = [
      ["title", node.title],
      ["description", node.description],
    ];
    if (node.type === "agent_task") fields.push(["prompt", node.prompt]);
    if (node.type === "prompt") fields.push(["prompt", node.prompt]);
    if (node.type === "script") fields.push(["command", node.command]);

    for (const [field, text] of fields) {
      if (!text) continue;
      scanText(node.id, field, text, items);
      // A whole-word occurrence of a bound project id inside prose.
      for (const proj of projectIds) {
        if (proj.length >= 3) {
          const re = new RegExp(`\\b${escapeRegExp(proj)}\\b`, "g");
          for (const m of text.matchAll(re)) {
            items.push({
              nodeId: node.id,
              field,
              kind: "project_name",
              match: m[0],
              note: "the source project name",
            });
          }
        }
      }
    }

    if (node.type === "agent_task") {
      for (const skill of node.skills ?? []) {
        items.push({
          nodeId: node.id,
          field: "skills",
          kind: "skill",
          match: skill,
          note: "verify this skill exists on the target installation",
        });
      }
      if (node.branch !== undefined) {
        items.push({
          nodeId: node.id,
          field: "branch",
          kind: "branch",
          match: node.branch,
          note: "the stacked feature branch name",
        });
      }
    }
  }
  return dedupeInventory(items);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function dedupeInventory(items: InventoryItem[]): InventoryItem[] {
  const seen = new Set<string>();
  const out: InventoryItem[] = [];
  for (const item of items) {
    const key = `${item.nodeId} ${item.field} ${item.kind} ${item.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guide (.template.md) assembly.
// ---------------------------------------------------------------------------

const KIND_TITLE: Record<InventoryItem["kind"], string> = {
  path: "filesystem path",
  repo: "git repository",
  channel: "delivery channel / chat id",
  project_name: "source project name",
  kanban_wrapper: "kanban wrapper / Hermes home path",
  url: "URL",
  branch: "feature branch",
  skill: "skill",
};

function placeholderWhatIs(p: TemplatePlaceholder): string {
  switch (p.kind) {
    case "project":
      return "the project / board this workflow binds to";
    case "profile":
      return p.nodeId
        ? `the agent profile for node \`${p.nodeId}\``
        : "the workflow's default agent profile";
    case "model":
      return p.nodeId
        ? `the model for node \`${p.nodeId}\``
        : "the workflow's default model";
    case "deliver":
      return "where the run's result is delivered (a Hermes DeliveryTarget)";
    case "workdir":
      return `the working directory for node \`${p.nodeId}\``;
    case "task_ref":
      return `the Kanban card id node \`${p.nodeId}\` drives (an \`adopt\` node)`;
  }
}

function placeholderPrereq(p: TemplatePlaceholder): string {
  switch (p.kind) {
    case "project":
      return "a project with a Kanban board on the target installation";
    case "profile":
      return "an agent profile of the recommended type exists in the roster";
    case "model":
      return "a provider/model of the recommended capability is configured";
    case "deliver":
      return "a delivery target (chat/thread/email) the run can post to";
    case "workdir":
      return "a checked-out repo / working directory on the target host";
    case "task_ref":
      return "an existing Kanban card to drive";
  }
}

function buildGuide(
  workflow: Workflow,
  placeholders: TemplatePlaceholder[],
  inventory: InventoryItem[],
  version: TemplateVersion,
  hints: GuideHints | undefined,
  links: PrereqLinks,
): string {
  const L: string[] = [];
  L.push(`# ${workflow.name} — workflow template`);
  L.push("");
  L.push(
    `**Version:** \`${version.human_version}\` ` +
      `(template_format ${version.template_format} · source workflow v${version.source.workflow_version} · revision ${version.revision})`,
  );
  L.push(
    `**Generated:** ${version.generation.generated_at} · generator v${version.generation.generator_version} · ` +
      `hints model: ${version.generation.model ?? "none (deterministic fallback)"}`,
  );
  L.push(`**Source spec:** \`${version.source.spec_sha}\``);
  L.push("");

  // --- Prerequisites (MUST be first). ---
  L.push("## Prerequisites");
  L.push("");
  L.push("> Read this block before instantiating the template.");
  L.push("");
  L.push(
    `- **REQUIRED — the \`hermes-workflows\` plugin must be installed.** This ` +
      `template uses the \`template_format: ${version.template_format}\` artifact schema; the consuming ` +
      `plugin must be at least **v${MIN_PLUGIN_VERSION}** to read it. Install with ` +
      `\`hermes plugins install hermes-workflows\` and read its adaptation contract: ${links.workflowsLlms}.`,
  );
  L.push(
    `- **RECOMMENDED — the \`o2b\` (open-second-brain) plugin.** Several nodes can ` +
      `record/recall memory through it; install with \`hermes plugins install open-second-brain\` ` +
      `and follow its \`llms.txt\`: ${links.o2bLlms}.`,
  );
  L.push("");

  // --- How to instantiate. ---
  L.push("## How to instantiate");
  L.push("");
  L.push(
    `1. Copy \`${workflow.id}.template.yaml\` to a new workflow spec and remove the ` +
      `\`template:\` block.`,
  );
  L.push(
    "2. Replace every `${...}` placeholder below with a concrete value for your " +
      "installation (your project, profiles, models, delivery target).",
  );
  L.push(
    "3. Adapt the in-prompt references listed at the end (these were left in the " +
      "prose verbatim — the export never rewrites prompt bodies).",
  );
  L.push("4. Save it as a normal workflow, validate, and run.");
  L.push("");
  if (hints?.overview && hints.overview.trim()) {
    L.push(`**What this workflow does.** ${hints.overview.trim()}`);
    L.push("");
  }

  // --- Workflow-level placeholders (scope/defaults/deliver). ---
  const workflowLevel = placeholders.filter((p) => p.nodeId === undefined);
  if (workflowLevel.length > 0) {
    L.push("## Workflow-level placeholders");
    L.push("");
    for (const p of workflowLevel) {
      L.push(`- \`${p.token}\` — ${placeholderWhatIs(p)}. Prerequisite: ${placeholderPrereq(p)}.`);
    }
    L.push("");
  }

  // --- Per-node recommendations + placeholders + in-prompt inventory. ---
  L.push("## Per-node placeholders & recommendations");
  L.push("");
  const byNodePlaceholders = groupBy(placeholders.filter((p) => p.nodeId !== undefined), (p) =>
    String(p.nodeId),
  );
  const byNodeInventory = groupBy(inventory, (i) => i.nodeId);
  for (const node of workflow.nodes) {
    const nodePh = byNodePlaceholders.get(node.id) ?? [];
    const nodeInv = byNodeInventory.get(node.id) ?? [];
    const isAgent = node.type === "agent_task";
    if (!isAgent && nodePh.length === 0 && nodeInv.length === 0) continue;

    L.push(`### Node \`${node.id}\`${node.title ? ` (${node.title})` : ""} — ${node.type}`);
    L.push("");
    if (isAgent) {
      L.push(`- **Recommended profile type:** ${roleHint(node, hints)}.`);
      L.push(`- **Recommended model capability:** ${capabilityHint(node, hints)}.`);
    }
    for (const p of nodePh) {
      L.push(`- **\`${p.token}\`** — ${placeholderWhatIs(p)}. Prerequisite: ${placeholderPrereq(p)}.`);
    }
    if (nodeInv.length > 0) {
      L.push("- **In-prompt references to adapt** (left verbatim — not rewritten):");
      for (const item of nodeInv) {
        const note = item.note ? ` — ${item.note}` : "";
        L.push(`  - ${item.field} · ${KIND_TITLE[item.kind]}: \`${item.match}\`${note}`);
      }
    }
    L.push("");
  }

  // --- Inventory summary (also surfaced inline above; kept whole for scanning). ---
  L.push("## All in-prompt references to adapt");
  L.push("");
  L.push(
    "These appear inside node prompt/command bodies (and titles/descriptions) and " +
      "were **not** rewritten — rewriting prose risks distorting a node's meaning. " +
      "Edit them by hand to match your installation:",
  );
  L.push("");
  if (inventory.length === 0) {
    L.push("_No installation-specific references detected in prose bodies._");
  } else {
    for (const item of inventory) {
      const note = item.note ? ` — ${item.note}` : "";
      L.push(
        `- Node \`${item.nodeId}\` · ${item.field} · ${KIND_TITLE[item.kind]}: \`${item.match}\`${note}`,
      );
    }
  }
  L.push("");

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Produce the full template bundle (YAML + guide + version + metadata) from a
 * source workflow. Pure and deterministic given `opts.generatedAt`; `opts.hints`
 * (AI-generated) enrich the guide and profile/model hints, and their absence
 * falls back to deterministic hints.
 */
export function exportTemplate(workflow: Workflow, opts: ExportTemplateOptions): TemplateBundle {
  const templateFormat = opts.templateFormat ?? TEMPLATE_FORMAT;
  const generatorVersion = opts.generatorVersion ?? GENERATOR_VERSION;
  const links = opts.prereqLinks ?? DEFAULT_PREREQ_LINKS;
  const sha = specSha(workflow);
  const cacheKey = templateCacheKey(workflow.id, sha, templateFormat, generatorVersion);
  const revision = templateRevision(cacheKey);

  const version: TemplateVersion = {
    template_format: templateFormat,
    source: { workflow_id: workflow.id, workflow_version: workflow.version, spec_sha: sha },
    generation: {
      generator_version: generatorVersion,
      model: opts.model ?? null,
      generated_at: opts.generatedAt,
    },
    revision,
    human_version: `fmt${templateFormat}·wf${workflow.version}·r${revision.slice(0, 4)}`,
  };

  const { workflow: debound, placeholders } = debindWorkflow(workflow, opts.hints);
  const inventory = inventoryWorkflow(workflow);

  // The `template:` provenance block is stamped ahead of the workflow body. The
  // loader ignores it (unknown top-level key) so the YAML still parses as a spec.
  const prelude: Record<string, unknown> = { template: version };
  const templateYaml = serializeWorkflow(debound, undefined, prelude);

  const guideMarkdown = buildGuide(workflow, placeholders, inventory, version, opts.hints, links);

  return { templateYaml, guideMarkdown, version, placeholders, inventory, specSha: sha, cacheKey };
}
