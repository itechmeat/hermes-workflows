/**
 * Serialize a workflow (plus optional ui layout) back to a portable spec string.
 *
 * Bun ships `Bun.YAML.parse` but no stringify, and the project keeps zero runtime
 * dependencies. So this emitter writes YAML *structure* (indented maps, block
 * sequences) while every *scalar* goes through `JSON.stringify`. A JSON
 * double-quoted string is a valid YAML double-quoted scalar, so the round-trip
 * `parseWorkflow(serializeWorkflow(w, ui))` deep-equals `{ workflow: w, ui }` by
 * construction — multiline prompts and special characters are escaped safely.
 *
 * A multiline string in a mapping is emitted as a `|` block scalar so authored
 * prompts/commands stay hand-readable across the round trip. This is applied
 * only when it is provably lossless (see {@link blockScalar}); every other
 * string falls back to the JSON-quoted form, so the round-trip guarantee holds.
 *
 * Known limit: YAML comments are not round-tripped (the spec carries none).
 */

import type { Workflow } from "../schema/workflow.ts";
import type { UiLayout } from "../schema/ui.ts";

const INDENT = "  ";

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/** Every scalar (string, number, boolean, null) emits as a JSON-quoted token. */
function scalar(value: unknown): string {
  return JSON.stringify(value);
}

interface BlockScalar {
  /** The block indicator: `|` (clip, one trailing newline) or `|-` (strip). */
  indicator: string;
  /** Content lines, already prefixed with `contentPad` (blank lines stay "").*/
  lines: string[];
}

/**
 * Render a string as a YAML block scalar at `contentPad` indentation, or return
 * null when a block scalar could not represent it without loss (so the caller
 * keeps the quoted form). Lossless only:
 *  - the string is multiline (a single line is better as a quoted scalar);
 *  - its trailing newline count is 0 (`|-`) or 1 (`|`); 2+ is ambiguous to clip;
 *  - the first content line is non-empty and not indented (block scalars infer
 *    indentation from it, which would eat leading spaces / a blank lead line);
 *  - no content line has trailing whitespace or a carriage return (block scalars
 *    drop trailing spaces and normalise line breaks).
 */
function blockScalar(value: string, contentPad: string): BlockScalar | null {
  if (!value.includes("\n") || value.includes("\r")) return null;

  const trailing = (value.match(/\n*$/)?.[0] ?? "").length;
  let indicator: string;
  let content: string[];
  if (trailing === 0) {
    indicator = "|-";
    content = value.split("\n");
  } else if (trailing === 1) {
    indicator = "|";
    content = value.slice(0, -1).split("\n");
  } else {
    return null; // 2+ trailing newlines: keep quoting (clip/strip can't express it)
  }

  if (content.length === 0 || content[0] === "" || /^[ \t]/.test(content[0] as string)) {
    return null; // blank or indented first line breaks YAML indentation inference
  }
  for (const line of content) {
    if (/[ \t]$/.test(line)) return null; // trailing whitespace would be lost
  }

  return { indicator, lines: content.map((line) => (line === "" ? "" : contentPad + line)) };
}

/** Emit `key: value` for a scalar, preferring a block scalar for a multiline
 *  string when lossless, else the quoted form. */
function emitScalarEntry(pad: string, key: string, value: unknown): string[] {
  if (typeof value === "string") {
    const block = blockScalar(value, pad + INDENT);
    if (block) return [`${pad}${key}: ${block.indicator}`, ...block.lines];
  }
  return [`${pad}${key}: ${scalar(value)}`];
}

function definedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).filter(([, v]) => v !== undefined);
}

function emitMapping(obj: Record<string, unknown>, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];
  for (const [key, value] of definedEntries(obj)) {
    // Keys go through the same JSON-quoting as scalars: map keys can be
    // user-controlled (e.g. agent_task.input_mapping), so quoting keeps the
    // round-trip lossless and prevents a crafted key from injecting YAML.
    const k = scalar(key);
    if (isScalar(value)) {
      lines.push(...emitScalarEntry(pad, k, value));
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else {
        lines.push(`${pad}${k}:`);
        lines.push(...emitSequence(value, depth + 1));
      }
    } else {
      const entries = definedEntries(value as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${pad}${k}: {}`);
      } else {
        lines.push(`${pad}${k}:`);
        lines.push(...emitMapping(value as Record<string, unknown>, depth + 1));
      }
    }
  }
  return lines;
}

function emitSequence(arr: unknown[], depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];
  for (const item of arr) {
    if (isScalar(item)) {
      lines.push(`${pad}- ${scalar(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${pad}-`);
      lines.push(...emitSequence(item, depth + 1));
    } else {
      const entries = definedEntries(item as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${pad}- {}`);
      } else {
        // Dash on its own line, mapping keys indented under it (valid YAML).
        lines.push(`${pad}-`);
        lines.push(...emitMapping(item as Record<string, unknown>, depth + 1));
      }
    }
  }
  return lines;
}

/**
 * Emit `workflow` (and `ui`, when present) as a portable YAML spec string.
 *
 * `prelude` lets a caller stamp extra top-level keys ahead of the workflow body
 * (e.g. template export's `template:` provenance block). It goes through the
 * same lossless emitter, and the loader ignores unknown top-level keys, so the
 * emitted document still parses as a workflow. Prelude keys are emitted first;
 * none collide with workflow field names in practice.
 */
export function serializeWorkflow(
  workflow: Workflow,
  ui?: UiLayout,
  prelude?: Record<string, unknown>,
): string {
  const doc: Record<string, unknown> = { ...(prelude ?? {}), ...workflow };
  if (ui !== undefined) doc["ui"] = ui;
  return emitMapping(doc, 0).join("\n") + "\n";
}
