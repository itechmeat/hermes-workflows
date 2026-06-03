import type { FlowNode } from "./graphMapping";
import type { ModelGroup, ReviewOption, WorkflowNode } from "../api/types";
import { Field } from "../ui/components";

const REVIEW_OPTIONS: ReviewOption[] = ["approved", "rejected", "needs_changes"];
const WORKSPACE_KINDS = ["scratch", "worktree"] as const;

export interface NodeInspectorProps {
  node: FlowNode | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
  /** Profile options (Hermes roster) and model options grouped by provider. */
  profiles?: string[];
  modelGroups?: ModelGroup[];
}

/** Parse a number input: blank clears the field (undefined), otherwise the
 *  numeric value (NaN is treated as cleared so a half-typed entry never sticks). */
function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/** Option list for a select: the known values plus the current one (so a value
 *  not in the user's current roster/models is still selectable and preserved). */
function withCurrent(options: string[], current: string | undefined): string[] {
  if (current && !options.includes(current)) return [current, ...options];
  return options;
}

/** Whether a model value (`model@provider`) is one of the listed provider
 *  options, so a not-listed (e.g. legacy bare) value can be shown separately. */
function modelGroupsContain(groups: ModelGroup[], value: string): boolean {
  return groups.some((g) => g.models.some((m) => `${m}@${g.provider}` === value));
}

// Node editor body: edit the selected node's fields. Field set is per node type.
// The node type/id live in the modal header and on the canvas node, so they are
// not repeated here; everything else is editable and patched back through
// onChange → useFlowEditor.updateNode.
export function NodeInspector({
  node,
  onChange,
  profiles = [],
  modelGroups = [],
}: NodeInspectorProps): React.ReactElement {
  if (node === null) {
    return <p className="hw-note">Select a node to edit.</p>;
  }

  const wf = node.data.node;

  return (
    <div className="hw-form">
      <Field label="Title">
        <input
          className="hw-input"
          aria-label="Title"
          value={wf.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value || undefined })}
        />
      </Field>

      {wf.type === "agent_task" && (
        <>
          <Field label="Prompt">
            <textarea
              className="hw-input hw-textarea--tall"
              aria-label="Prompt"
              value={wf.prompt}
              onChange={(e) => onChange({ prompt: e.target.value })}
            />
          </Field>
          <Field label="Profile">
            <select
              className="hw-select"
              aria-label="Profile"
              value={wf.profile ?? ""}
              onChange={(e) => onChange({ profile: e.target.value || undefined })}
            >
              <option value="">(default)</option>
              {withCurrent(profiles, wf.profile).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select
              className="hw-select"
              aria-label="Model"
              value={wf.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
            >
              <option value="">(default)</option>
              {/* Current value, if it isn't one of the listed provider models
                 (e.g. a legacy bare model name) — keep it selectable. */}
              {wf.model && !modelGroupsContain(modelGroups, wf.model) && (
                <option value={wf.model}>{wf.model}</option>
              )}
              {modelGroups.map((group) => (
                <optgroup key={group.provider} label={group.label}>
                  {group.models.map((m) => {
                    const value = `${m}@${group.provider}`;
                    return (
                      <option key={value} value={value}>
                        {m}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Skills (comma-separated)">
            <input
              className="hw-input"
              aria-label="Skills"
              value={(wf.skills ?? []).join(", ")}
              onChange={(e) => onChange({ skills: splitSkills(e.target.value) })}
            />
          </Field>
          <Field label="Workdir">
            <input
              className="hw-input"
              aria-label="Workdir"
              value={wf.workdir ?? ""}
              onChange={(e) => onChange({ workdir: e.target.value || undefined })}
            />
          </Field>
          <Field label="Workspace">
            <select
              className="hw-select"
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
          </Field>
          <Field label="Max retries">
            <input
              className="hw-input"
              aria-label="Max retries"
              type="number"
              min={0}
              value={wf.max_retries ?? ""}
              onChange={(e) => onChange({ max_retries: numberOrUndefined(e.target.value) })}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <input
              className="hw-input"
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </>
      )}

      {wf.type === "script" && (
        <>
          <Field label="Command">
            <textarea
              className="hw-input hw-textarea--tall"
              aria-label="Command"
              value={wf.command}
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </Field>
          <Field label="Workdir">
            <input
              className="hw-input"
              aria-label="Workdir"
              value={wf.workdir ?? ""}
              onChange={(e) => onChange({ workdir: e.target.value || undefined })}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <input
              className="hw-input"
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </Field>
          <Field label="Env allowlist (comma-separated)">
            <input
              className="hw-input"
              aria-label="Env allowlist"
              value={(wf.env ?? []).join(", ")}
              onChange={(e) => {
                const list = splitList(e.target.value);
                onChange({ env: list.length > 0 ? list : undefined });
              }}
            />
          </Field>
        </>
      )}

      {wf.type === "human_review" && (
        <fieldset className="hw-fieldset">
          <legend>Review options</legend>
          {REVIEW_OPTIONS.map((option) => {
            const current = wf.options ?? REVIEW_OPTIONS;
            const checked = current.includes(option);
            return (
              <label key={option} className="hw-checkbox">
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
        <Field label="Outcome">
          <select
            className="hw-select"
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
        </Field>
      )}
    </div>
  );
}

function splitSkills(value: string): string[] {
  return splitList(value);
}

/** Split a comma-separated list into trimmed, non-empty items. */
function splitList(value: string): string[] {
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
