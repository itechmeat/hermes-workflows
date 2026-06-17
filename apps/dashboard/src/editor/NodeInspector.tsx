import type { FlowNode } from "./graphMapping";
import type { ModelGroup, ReviewOption, WorkflowNode } from "../api/types";
import { Checkbox, Field, Input, Select, Textarea, type SelectItem } from "../ui/components";

const REVIEW_OPTIONS: ReviewOption[] = ["approved", "rejected", "needs_changes"];
const WORKSPACE_KINDS = ["scratch", "worktree"] as const;
const OUTCOMES = ["success", "failure"] as const;

export interface NodeInspectorProps {
  node: FlowNode | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
  /** Profile options (Hermes roster) and model options grouped by provider. */
  profiles?: string[];
  modelGroups?: ModelGroup[];
  /** Skill catalog from the host `/api/skills` (the same catalog the host's
   *  cron modals use). The node's current skills not in it are still shown. */
  skills?: string[];
  /** Render every control disabled (pure inspection). Used while a run is in
   *  progress so the operator can review a node's configuration at any moment
   *  without risking an edit to a live run. */
  readOnly?: boolean;
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

const DEFAULT_ITEM: SelectItem = { value: "", label: "(default)" };

/** Profile select items: a "(default)" entry plus the roster, preserving an
 *  out-of-roster current value. */
function profileItems(profiles: string[], current: string | undefined): SelectItem[] {
  return [DEFAULT_ITEM, ...withCurrent(profiles, current).map((p) => ({ value: p, label: p }))];
}

/** Model select items: "(default)", any legacy/out-of-list current value, then
 *  the provider-grouped models (`model@provider` value shown as the bare model). */
function modelItems(groups: ModelGroup[], current: string | undefined): SelectItem[] {
  const items: SelectItem[] = [DEFAULT_ITEM];
  if (current && !modelGroupsContain(groups, current)) {
    items.push({ value: current, label: current });
  }
  for (const group of groups) {
    for (const m of group.models) {
      items.push({ value: `${m}@${group.provider}`, label: m, group: group.label });
    }
  }
  return items;
}

const WORKSPACE_ITEMS: SelectItem[] = [
  DEFAULT_ITEM,
  ...WORKSPACE_KINDS.map((k) => ({ value: k, label: k })),
];

const OUTCOME_ITEMS: SelectItem[] = [
  { value: "", label: "(unset)" },
  ...OUTCOMES.map((o) => ({ value: o, label: o })),
];

// Per-node completion-notification control. "" inherits the workflow-level
// subscribe_cards default; "on"/"off" override it for this node's card only.
const NOTIFY_ITEMS: SelectItem[] = [
  { value: "", label: "Inherit workflow default" },
  { value: "on", label: "Notify when this card completes" },
  { value: "off", label: "Stay quiet for this node" },
];

/** Narrow a select value to a workspace kind (or undefined for "(default)"),
 *  without an unchecked cast — the items guarantee membership. */
function asWorkspaceKind(value: string): (typeof WORKSPACE_KINDS)[number] | undefined {
  return WORKSPACE_KINDS.find((k) => k === value);
}

function asOutcome(value: string): (typeof OUTCOMES)[number] | undefined {
  return OUTCOMES.find((o) => o === value);
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
  skills = [],
  readOnly = false,
}: NodeInspectorProps): React.ReactElement {
  if (node === null) {
    return <p className="hw-note">Select a node to edit.</p>;
  }

  const wf = node.data.node;

  // A disabled <fieldset> natively disables every descendant control - native
  // inputs/textareas and the Base UI select/checkbox button widgets alike - so
  // read-only inspection cannot miss a field as the form grows.
  return (
    <fieldset className="hw-form hw-form--inspector" disabled={readOnly}>
      <Field label="Title">
        <Input
          aria-label="Title"
          value={wf.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value || undefined })}
        />
      </Field>

      {wf.type === "agent_task" && (
        <>
          <Field label="Prompt">
            <Textarea
              className="hw-textarea--tall"
              aria-label="Prompt"
              value={wf.prompt}
              onChange={(e) => onChange({ prompt: e.target.value })}
            />
          </Field>
          <Field label="Profile">
            <Select
              aria-label="Profile"
              value={wf.profile ?? ""}
              items={profileItems(profiles, wf.profile)}
              onValueChange={(value) => onChange({ profile: value || undefined })}
            />
          </Field>
          <Field label="Model">
            <Select
              aria-label="Model"
              value={wf.model ?? ""}
              items={modelItems(modelGroups, wf.model)}
              onValueChange={(value) => onChange({ model: value || undefined })}
            />
          </Field>
          <fieldset className="hw-fieldset">
            <legend>Skills</legend>
            {skillOptions(skills, wf.skills ?? []).map((skill) => {
              const current = wf.skills ?? [];
              return (
                <Checkbox
                  key={skill}
                  checked={current.includes(skill)}
                  disabled={readOnly}
                  onCheckedChange={(on) => onChange({ skills: toggleSkill(current, skill, on) })}
                >
                  {skill}
                </Checkbox>
              );
            })}
            {skillOptions(skills, wf.skills ?? []).length === 0 && (
              <p className="hw-note">No skills available.</p>
            )}
          </fieldset>
          <Field label="Workdir">
            <Input
              aria-label="Workdir"
              value={wf.workdir ?? ""}
              onChange={(e) => onChange({ workdir: e.target.value || undefined })}
            />
          </Field>
          <Field label="Workspace">
            <Select
              aria-label="Workspace"
              value={wf.workspace?.type ?? ""}
              items={WORKSPACE_ITEMS}
              onValueChange={(value) => {
                const kind = asWorkspaceKind(value);
                onChange({ workspace: kind ? { type: kind } : undefined });
              }}
            />
          </Field>
          <Field label="Max retries">
            <Input
              aria-label="Max retries"
              type="number"
              min={0}
              value={wf.max_retries ?? ""}
              onChange={(e) => onChange({ max_retries: numberOrUndefined(e.target.value) })}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </Field>
          <Field label="Completion notification">
            <Select
              aria-label="Completion notification"
              value={wf.notify_completion === undefined ? "" : wf.notify_completion ? "on" : "off"}
              items={NOTIFY_ITEMS}
              onValueChange={(value) =>
                onChange({ notify_completion: value === "" ? undefined : value === "on" })
              }
            />
          </Field>
          <fieldset className="hw-fieldset">
            <legend>Board</legend>
            <Checkbox
              checked={wf.board !== false}
              disabled={readOnly}
              onCheckedChange={(on) => onChange({ board: on ? undefined : false })}
            >
              Run on the project board
            </Checkbox>
            <p className="hw-note">
              On by default: the node runs as a Kanban card. Turn off to run an
              internal orchestration step off the board (no card, no worktree),
              so the operator board keeps only the real work.
            </p>
          </fieldset>
        </>
      )}

      {wf.type === "prompt" && (
        <Field label="Prompt">
          <Textarea
            className="hw-textarea--tall"
            aria-label="Prompt"
            value={wf.prompt ?? ""}
            onChange={(e) => onChange({ prompt: e.target.value || undefined })}
          />
          <p className="hw-note">
            Layered above the prompt of each agent task this node connects to, as the primary
            instruction. Optional.
          </p>
        </Field>
      )}

      {wf.type === "script" && (
        <>
          <Field label="Command">
            <Textarea
              className="hw-textarea--tall"
              aria-label="Command"
              value={wf.command}
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </Field>
          <Field label="Workdir">
            <Input
              aria-label="Workdir"
              value={wf.workdir ?? ""}
              onChange={(e) => onChange({ workdir: e.target.value || undefined })}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </Field>
          <Field label="Env allowlist (comma-separated)">
            <Input
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
              <Checkbox
                key={option}
                checked={checked}
                disabled={readOnly}
                onCheckedChange={(on) => onChange({ options: toggleOption(current, option, on) })}
              >
                {option}
              </Checkbox>
            );
          })}
        </fieldset>
      )}

      {wf.type === "wait" && (
        <>
          <Field label="Wait for PR merge (URL/number, or {{nodes.<id>.output}})">
            <Input
              aria-label="PR reference"
              value={wf.wait_for?.github_pr_merged ?? ""}
              onChange={(e) => onChange({ wait_for: { github_pr_merged: e.target.value } })}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              aria-label="Timeout (seconds)"
              type="number"
              min={0}
              value={wf.timeout_seconds ?? ""}
              onChange={(e) => onChange({ timeout_seconds: numberOrUndefined(e.target.value) })}
            />
          </Field>
        </>
      )}

      {wf.type === "condition" && (
        <p className="hw-note">
          A condition node routes by outcome - it runs nothing itself. Draw an edge from its{" "}
          <strong>success</strong> or <strong>failure</strong> handle to branch on the upstream
          result, and from <strong>else</strong> for the fallback path. Select any edge to
          fine-tune its condition (including branching on another node's status).
        </p>
      )}

      {wf.type === "finish" && (
        <Field label="Outcome">
          <Select
            aria-label="Outcome"
            value={wf.outcome ?? ""}
            items={OUTCOME_ITEMS}
            onValueChange={(value) => onChange({ outcome: asOutcome(value) })}
          />
        </Field>
      )}
    </fieldset>
  );
}

/** Skill checkbox options: the host catalog plus any current skill not in it
 *  (preserve-unknown, mirroring the model/profile pickers). */
function skillOptions(catalog: string[], current: string[]): string[] {
  const extras = current.filter((s) => !catalog.includes(s));
  return [...catalog, ...extras];
}

/** Toggle one skill in the node's selection; emptied selection clears to
 *  undefined (no persisted empty array), mirroring the env allowlist. */
function toggleSkill(current: string[], skill: string, on: boolean): string[] | undefined {
  const next = on
    ? current.includes(skill)
      ? current
      : [...current, skill]
    : current.filter((s) => s !== skill);
  return next.length > 0 ? next : undefined;
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
