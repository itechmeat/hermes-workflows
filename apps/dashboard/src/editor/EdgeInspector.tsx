import type { FlowEdge, WorkflowEdgeData } from "./graphMapping";
import { Field, Select, type SelectItem } from "../ui/components";

// Edit a selected edge's branch cause. The common outcomes (success / failure /
// a review decision / else / plain) map straight onto the source node's handles;
// "another node's status" is the advanced case the per-handle model cannot
// express (branch on a node OTHER than the edge's source), kept so the engine's
// full edge-condition capability stays reachable from the editor.
export interface EdgeInspectorProps {
  edge: FlowEdge;
  /** Candidate source nodes for the advanced cross-node condition. */
  nodeIds: string[];
  onChange: (data: WorkflowEdgeData) => void;
  readOnly?: boolean;
}

type BranchKind =
  | "plain"
  | "success"
  | "failure"
  | "approved"
  | "rejected"
  | "needs_changes"
  | "else"
  | "advanced";

const BRANCH_ITEMS: SelectItem[] = [
  { value: "plain", label: "Always (plain / parallel)" },
  { value: "success", label: "On success" },
  { value: "failure", label: "On failure" },
  { value: "approved", label: "On approved" },
  { value: "rejected", label: "On rejected" },
  { value: "needs_changes", label: "On needs_changes" },
  { value: "else", label: "Fallback (else)" },
  { value: "advanced", label: "On another node's status…" },
];

const STATUS_EQUALS = ["success", "failure"] as const;

function readKind(edge: FlowEdge): {
  kind: BranchKind;
  advNode: string;
  advEquals: (typeof STATUS_EQUALS)[number];
} {
  const data = edge.data;
  if (data?.fallback) return { kind: "else", advNode: "", advEquals: "success" };
  const c = data?.condition;
  if (c === undefined) return { kind: "plain", advNode: "", advEquals: "success" };
  if (c.type === "review_status") return { kind: c.equals, advNode: "", advEquals: "success" };
  if (c.node === edge.source) return { kind: c.equals, advNode: "", advEquals: c.equals };
  return { kind: "advanced", advNode: c.node, advEquals: c.equals };
}

function buildData(
  kind: BranchKind,
  source: string,
  advNode: string,
  advEquals: (typeof STATUS_EQUALS)[number],
): WorkflowEdgeData {
  switch (kind) {
    case "plain":
      return {};
    case "else":
      return { fallback: true };
    case "success":
    case "failure":
      return { condition: { type: "node_status", node: source, equals: kind } };
    case "approved":
    case "rejected":
    case "needs_changes":
      return { condition: { type: "review_status", equals: kind } };
    case "advanced":
      return { condition: { type: "node_status", node: advNode || source, equals: advEquals } };
  }
}

export function EdgeInspector({
  edge,
  nodeIds,
  onChange,
  readOnly = false,
}: EdgeInspectorProps): React.ReactElement {
  const { kind, advNode, advEquals } = readKind(edge);
  const nodeItems: SelectItem[] = nodeIds
    .filter((id) => id !== edge.target)
    .map((id) => ({ value: id, label: id }));
  const equalsItems: SelectItem[] = STATUS_EQUALS.map((e) => ({ value: e, label: e }));

  return (
    <fieldset className="hw-form hw-form--inspector" disabled={readOnly}>
      <p className="hw-note">
        {edge.source} → {edge.target}
      </p>
      <Field label="Branch when">
        <Select
          aria-label="Branch when"
          value={kind}
          items={BRANCH_ITEMS}
          onValueChange={(value) =>
            onChange(buildData(value as BranchKind, edge.source, advNode, advEquals))
          }
        />
      </Field>
      {kind === "advanced" && (
        <>
          <Field label="Source node">
            <Select
              aria-label="Source node"
              value={advNode || edge.source}
              items={nodeItems}
              onValueChange={(value) => onChange(buildData("advanced", edge.source, value, advEquals))}
            />
          </Field>
          <Field label="Equals">
            <Select
              aria-label="Equals"
              value={advEquals}
              items={equalsItems}
              onValueChange={(value) =>
                onChange(
                  buildData(
                    "advanced",
                    edge.source,
                    advNode,
                    value === "failure" ? "failure" : "success",
                  ),
                )
              }
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}
