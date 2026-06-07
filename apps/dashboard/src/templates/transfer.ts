// The JSON transfer format for workflows: exactly the `{ workflow, ui? }`
// authoring shape the API speaks (POST/PUT /workflows), pretty-printed. Pure
// functions, no DOM — the Templates page wires them to the download helper and
// a file input. Parsing throws descriptive errors so the page can show "not
// valid JSON" / "not a workflow JSON export" instead of a confusing
// graph-validation 400; everything semantic stays with core validation.
import type { CreateWorkflowBody, SpecDetail } from "../api/types";

export interface WorkflowJsonFile {
  filename: string;
  content: string;
}

/** Serialize a workflow for download as `<id>.workflow.json` — the on-disk
 *  naming the spec store also reads. `path` is server-local and never travels;
 *  `ui` is omitted (not nulled) when the spec has no layout. */
export function workflowJsonFile(detail: SpecDetail): WorkflowJsonFile {
  const body: CreateWorkflowBody = {
    workflow: detail.workflow,
    ...(detail.ui !== undefined ? { ui: detail.ui } : {}),
  };
  return {
    filename: `${detail.workflow.id}.workflow.json`,
    content: `${JSON.stringify(body, null, 2)}\n`,
  };
}

/** Parse an uploaded workflow JSON file into the `POST /workflows` body.
 *  Throws with a human-readable reason; the graph itself is validated by the
 *  core when the body is submitted, not here. */
export function parseWorkflowJsonFile(text: string): CreateWorkflowBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The file is not valid JSON: ${reason}`);
  }
  if (!isWorkflowExport(parsed)) {
    throw new Error(
      'The file is not a workflow JSON export: expected { "workflow": { "id": "...", ... }, "ui"?: ... }',
    );
  }
  const { workflow, ui } = parsed;
  return { workflow, ...(ui !== undefined ? { ui } : {}) };
}

/** The minimal shape that distinguishes a workflow export from arbitrary JSON:
 *  a `workflow` object with a string id. Deliberately nothing more — `ui` and
 *  the graph itself are NOT checked client-side; core validation (spec-create)
 *  is the single authority and its 400 detail reaches the operator verbatim. */
function isWorkflowExport(value: unknown): value is CreateWorkflowBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const workflow = (value as { workflow?: unknown }).workflow;
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) return false;
  return typeof (workflow as { id?: unknown }).id === "string";
}
