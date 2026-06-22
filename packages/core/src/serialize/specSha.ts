/**
 * `specSha` — a stable content hash over a workflow's serialized spec.
 *
 * Why this exists separately from the workflow `version`: the spec body can
 * change WITHOUT an integer `version` bump (an operator edits a prompt, a
 * timeout, a profile in the editor and saves). Anything that caches or compares
 * "the exact spec snapshot" — template export's regeneration key, "is this
 * template still current vs upstream?" — needs to detect that. `version` alone
 * cannot.
 *
 * The hash is taken over `serializeWorkflow(workflow)` (the canonical YAML
 * emitter), NOT the raw on-disk file: the emitter normalises key order and
 * quoting, and `parseWorkflow` reconstructs a workflow with a fixed field order,
 * so two specs that differ only cosmetically (key order, quoting style) hash
 * identically while any substantive edit changes the hash.
 *
 * The `ui` layout is deliberately excluded — node positions are presentation,
 * not spec substance, and moving a node on the canvas must not invalidate a
 * template generated from the workflow's logic.
 */

import { createHash } from "node:crypto";
import type { Workflow } from "../schema/workflow.ts";
import { serializeWorkflow } from "./serializeWorkflow.ts";

/** Stable `sha256:<hex>` content hash of the workflow's serialized spec. */
export function specSha(workflow: Workflow): string {
  const canonical = serializeWorkflow(workflow);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}
