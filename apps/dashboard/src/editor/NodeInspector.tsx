import { useRef, useState } from "react";
import type { FlowNode } from "./graphMapping";
import type { ReviewOption, WorkflowNode } from "../api/types";

const REVIEW_OPTIONS: ReviewOption[] = ["approved", "rejected", "needs_changes"];
const WORKSPACE_KINDS = ["scratch", "worktree"] as const;

export interface NodeInspectorProps {
  node: FlowNode | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

/** Parse a number input: blank clears the field (undefined), otherwise the
 *  numeric value (NaN is treated as cleared so a half-typed entry never sticks). */
function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 };

// Right rail: edit the selected node's fields. Field set is per node type. The
// node id is shown read-only (renaming would orphan edges); everything else is
// editable and patched back through onChange → useFlowEditor.updateNode.
export function NodeInspector({ node, onChange }: NodeInspectorProps): React.ReactElement {
  if (node === null) {
    return <div style={{ padding: 8, opacity: 0.6 }}>Select a node to edit.</div>;
  }

  const wf = node.data.node;

  return (
    <div style={{ padding: 8, minWidth: 220 }}>
      <div style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase" }}>{wf.type}</div>
      <div style={{ ...field }}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>Id</span>
        <code>{wf.id}</code>
      </div>

      <label style={field}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>Title</span>
        <input
          aria-label="Title"
          value={wf.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value || undefined })}
        />
      </label>

      <label style={field}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>Description</span>
        <textarea
          aria-label="Description"
          rows={2}
          value={wf.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
      </label>

      {wf.type === "agent_task" && (
        <>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Profile</span>
            <input
              aria-label="Profile"
              value={wf.profile ?? ""}
              onChange={(e) => onChange({ profile: e.target.value || undefined })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Model</span>
            <input
              aria-label="Model"
              value={wf.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Skills (comma-separated)</span>
            <input
              aria-label="Skills"
              value={(wf.skills ?? []).join(", ")}
              onChange={(e) => onChange({ skills: splitSkills(e.target.value) })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Prompt</span>
            <textarea
              aria-label="Prompt"
              rows={4}
              value={wf.prompt}
              onChange={(e) => onChange({ prompt: e.target.value })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Workdir</span>
            <input
              aria-label="Workdir"
              value={wf.workdir ?? ""}
              onChange={(e) => onChange({ workdir: e.target.value || undefined })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Workspace</span>
            <select
              aria-label="Workspace"
              value={wf.workspace?.type ?? ""}
              onChange={(e) =>
                onChange({
                  workspace:
                    e.target.value === ""
                      ? undefined
                      : { type: e.target.value as (typeof WORKSPACE_KINDS)[number] },
                })
              }
            >
              <option value="">(default)</option>
              {WORKSPACE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Max retries</span>
            <input
              aria-label="Max retries"
              type="number"
              min={0}
              value={wf.max_retries ?? ""}
              onChange={(e) => onChange({ max_retries: numberOrUndefined(e.target.value) })}
            />
          </label>
          <label style={field}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Timeout (seconds)</span>
            <input
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </label>
          <InputMappingEditor
            // Remount when the selected node changes so the row state reseeds.
            key={wf.id}
            value={wf.input_mapping ?? {}}
            onChange={(input_mapping) => onChange({ input_mapping })}
          />
        </>
      )}

      {wf.type === "human_review" && (
        <fieldset style={field}>
          <legend style={{ fontSize: 11, opacity: 0.6 }}>Review options</legend>
          {REVIEW_OPTIONS.map((option) => {
            const current = wf.options ?? REVIEW_OPTIONS;
            const checked = current.includes(option);
            return (
              <label key={option} style={{ display: "flex", gap: 6 }}>
                <input
                  type="checkbox"
                  aria-label={option}
                  checked={checked}
                  onChange={(e) =>
                    onChange({ options: toggleOption(current, option, e.target.checked) })
                  }
                />
                {option}
              </label>
            );
          })}
        </fieldset>
      )}

      {wf.type === "finish" && (
        <label style={field}>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Outcome</span>
          <select
            aria-label="Outcome"
            value={wf.outcome ?? ""}
            onChange={(e) =>
              onChange({ outcome: e.target.value === "" ? undefined : (e.target.value as "success" | "failure") })
            }
          >
            <option value="">(unset)</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </label>
      )}
    </div>
  );
}

function splitSkills(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toggleOption(current: ReviewOption[], option: ReviewOption, on: boolean): ReviewOption[] {
  const next = on ? [...current, option] : current.filter((o) => o !== option);
  // Keep canonical order, drop duplicates.
  return REVIEW_OPTIONS.filter((o) => next.includes(o));
}

interface MappingRow {
  /** Stable identity for the React list key, independent of key/value edits. */
  rid: number;
  key: string;
  value: string;
}

interface InputMappingEditorProps {
  value: Record<string, string>;
  onChange: (mapping: Record<string, string>) => void;
}

/**
 * Edit `input_mapping` as ordered key/value rows. A record cannot represent a
 * half-typed or duplicate key, so the rows live in local state; we only emit a
 * record back when the keys are unique. A duplicate is surfaced inline and
 * withheld, so the persisted spec never carries a colliding mapping.
 */
function InputMappingEditor({ value, onChange }: InputMappingEditorProps): React.ReactElement {
  const [rows, setRows] = useState<MappingRow[]>(() =>
    Object.entries(value).map(([key, val], i) => ({ rid: i, key, value: val })),
  );
  // Monotonic source of stable row ids for rows added after mount.
  const nextRid = useRef(rows.length);

  const nonEmptyKeys = rows.map((r) => r.key.trim()).filter((k) => k.length > 0);
  const hasDuplicate = nonEmptyKeys.length !== new Set(nonEmptyKeys).size;

  function update(next: MappingRow[]): void {
    setRows(next);
    const keys = next.map((r) => r.key.trim()).filter((k) => k.length > 0);
    if (keys.length !== new Set(keys).size) return; // withhold colliding maps
    const mapping: Record<string, string> = {};
    for (const row of next) {
      const key = row.key.trim();
      if (key.length > 0) mapping[key] = row.value;
    }
    onChange(mapping);
  }

  return (
    <fieldset style={field}>
      <legend style={{ fontSize: 11, opacity: 0.6 }}>Input mapping</legend>
      {rows.map((row, i) => (
        <div key={row.rid} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          <input
            aria-label={`Mapping key ${i + 1}`}
            placeholder="key"
            value={row.key}
            onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
          />
          <input
            aria-label={`Mapping value ${i + 1}`}
            placeholder="{{nodes.x.output}}"
            value={row.value}
            onChange={(e) => update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <button
            type="button"
            className="hw-btn hw-btn--sm"
            aria-label={`Remove mapping ${i + 1}`}
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      {hasDuplicate && (
        <span role="alert" style={{ fontSize: 11, color: "var(--color-destructive, #d35)" }}>
          Duplicate key — each mapping key must be unique.
        </span>
      )}
      <button
        type="button"
        className="hw-btn hw-btn--sm"
        onClick={() => update([...rows, { rid: nextRid.current++, key: "", value: "" }])}
      >
        Add mapping
      </button>
    </fieldset>
  );
}
