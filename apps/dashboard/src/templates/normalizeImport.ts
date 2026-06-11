// Import normalization: a workflow brought in from another environment may name
// models, profiles (agents), or skills that do not exist on THIS host. On
// import we reset those node fields to their defaults — drop an unknown `model`
// (the node falls back to the workflow/system default), drop an unknown
// `profile` (it falls back to `defaults.profile`), and drop unknown `skills`
// from the list — and report exactly what was reset so the operator sees it.
//
// This is scoped to the import boundary on purpose: the editor deliberately
// PRESERVES an unknown value (a momentarily unauthenticated provider should not
// wipe a model choice), so the ordinary save path is left untouched.
//
// A catalogue dimension is a `Set` of the values known on this host. A dimension
// left `undefined` means "could not be verified" (e.g. the host call failed):
// that field is then NOT touched, and the dimension is reported as unverified
// rather than silently treated as empty (which would wrongly strip everything).
import type { ModelGroup, CreateWorkflowBody } from "../api/types";

export interface ImportCatalog {
  /** Known `model@provider` keys; undefined = unverified (leave models alone). */
  models?: Set<string>;
  /** Known profile names; undefined = unverified. */
  profiles?: Set<string>;
  /** Known skill names; undefined = unverified. */
  skills?: Set<string>;
}

/** What a single node had reset. Only the fields that changed are present. */
export interface NodeReset {
  node: string;
  model?: string;
  profile?: string;
  droppedSkills?: string[];
}

export type CatalogDimension = "models" | "profiles" | "skills";

export interface NormalizeResult {
  body: CreateWorkflowBody;
  resets: NodeReset[];
  /** Dimensions that could not be verified, so nothing in them was changed. */
  unverified: CatalogDimension[];
}

/** The set of `model@provider` keys the host offers — the form a node's `model`
 *  field stores (see the NodeInspector model picker). */
export function modelKeySet(groups: ModelGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const model of group.models) keys.add(`${model}@${group.provider}`);
  }
  return keys;
}

/** Reset unknown model/profile/skills on a workflow's agent_task nodes against
 *  the host catalogue. Pure: returns a new body, never mutates the input. */
export function normalizeWorkflowForImport(
  body: CreateWorkflowBody,
  catalog: ImportCatalog,
): NormalizeResult {
  const resets: NodeReset[] = [];
  const modelSet = catalog.models;
  const profileSet = catalog.profiles;
  const skillSet = catalog.skills;

  // A well-formed workflow always has a nodes array; guard defensively so a
  // partial/minimal body passes through untouched rather than throwing.
  if (!Array.isArray(body.workflow.nodes)) {
    return { body, resets, unverified: [] };
  }

  let hasAgentNodes = false;
  const nodes = body.workflow.nodes.map((node) => {
    if (node.type !== "agent_task") return node;
    hasAgentNodes = true;
    const next = { ...node };
    const reset: NodeReset = { node: node.id };

    if (modelSet && next.model !== undefined && !modelSet.has(next.model)) {
      reset.model = next.model;
      delete next.model;
    }
    if (profileSet && next.profile !== undefined && !profileSet.has(next.profile)) {
      reset.profile = next.profile;
      delete next.profile;
    }
    if (skillSet && next.skills !== undefined) {
      const dropped = next.skills.filter((skill) => !skillSet.has(skill));
      if (dropped.length > 0) {
        reset.droppedSkills = dropped;
        const kept = next.skills.filter((skill) => skillSet.has(skill));
        if (kept.length > 0) next.skills = kept;
        else delete next.skills;
      }
    }

    if (
      reset.model !== undefined ||
      reset.profile !== undefined ||
      reset.droppedSkills !== undefined
    ) {
      resets.push(reset);
    }
    return next;
  });

  // Only report a dimension as unverified when an agent_task node could have
  // used it — otherwise the catalogue is irrelevant and the note is just noise.
  const unverified = hasAgentNodes
    ? (["models", "profiles", "skills"] as const).filter(
        (dimension) => catalog[dimension] === undefined,
      )
    : [];

  return {
    body: { ...body, workflow: { ...body.workflow, nodes } },
    resets,
    unverified,
  };
}

/** A one-line, operator-facing summary of what import normalization changed.
 *  Empty string when nothing was reset and every dimension was verified. */
export function describeImportNormalization(
  resets: NodeReset[],
  unverified: CatalogDimension[],
): string {
  const parts: string[] = [];

  const models = resets.filter((r) => r.model !== undefined).length;
  const profiles = resets.filter((r) => r.profile !== undefined).length;
  const skills = resets.reduce((sum, r) => sum + (r.droppedSkills?.length ?? 0), 0);
  const reset: string[] = [];
  if (models > 0) reset.push(`${models} model${models === 1 ? "" : "s"}`);
  if (profiles > 0) reset.push(`${profiles} profile${profiles === 1 ? "" : "s"}`);
  if (skills > 0) reset.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  if (reset.length > 0) parts.push(`reset unknown ${reset.join(", ")} to defaults`);

  if (unverified.length > 0) parts.push(`could not verify ${unverified.join(", ")} (left as-is)`);

  return parts.join("; ");
}
