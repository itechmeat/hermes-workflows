import { sourceHandlesFor, type FlowEdge, type WorkflowEdgeData } from "./graphMapping";
import { Field, Select, type SelectItem } from "../ui/components";

// Edit a selected edge's branch cause. The options are restricted to the SOURCE
// node's real outcomes (a work/condition node branches on success/failure; a
// human_review on its decision) so a choice always maps to a handle that exists
// on that node - otherwise the edge would bind to a missing handle and vanish.
// "another node's status" is the advanced case the per-handle model cannot
// express (branch on a node OTHER than the edge's source), kept so the engine's
// full edge-condition capability stays reachable from the editor.
export interface EdgeInspectorProps {
  edge: FlowEdge;
  /** The edge's source node type, to restrict the offered branch outcomes. */
  sourceType: string;
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

const BRANCH_LABEL: Record<string, string> = {
  out: "Always (plain / parallel)",
  success: "On success",
  failure: "On failure",
  approved: "On approved",
  rejected: "On rejected",
  needs_changes: "On needs_changes",
  else: "Fallback (else)",
};

/** Branch options valid for the edge's source node: its real outcome handles
 *  (the `out` handle shown as the plain "always" branch), plus the advanced
 *  cross-node condition. Offering an outcome the source node lacks is exactly
 *  what made an edge bind to a missing handle and disappear. */
function branchItems(sourceType: string): SelectItem[] {
  const items: SelectItem[] = sourceHandlesFor(sourceType).map((h) => ({
    value: h.id === "out" ? "plain" : h.id,
    label: BRANCH_LABEL[h.id] ?? h.id,
  }));
  items.push({ value: "advanced", label: "On another node's status…" });
  return items;
}

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
  sourceType,
  nodeIds,
  onChange,
  readOnly = false,
}: EdgeInspectorProps): React.ReactElement {
  const { kind, advNode, advEquals } = readKind(edge);
  const items = branchItems(sourceType);
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
          items={items}
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
