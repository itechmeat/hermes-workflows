import type { FlowNode } from "./graphMapping";
import type { ReviewOption, WorkflowNode } from "../api/types";

const REVIEW_OPTIONS: ReviewOption[] = ["approved", "rejected", "needs_changes"];

export interface NodeInspectorProps {
  node: FlowNode | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
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
