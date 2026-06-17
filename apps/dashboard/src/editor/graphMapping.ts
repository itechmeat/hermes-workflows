// Pure, lossless mapping between a workflow spec (+ ui layout) and the
// @xyflow/react node/edge model the canvas renders. Keeping this free of React
// and xyflow runtime lets the round-trip be unit-tested directly: load a spec,
// map to flow, map back, and the spec + ui are unchanged.
import type { Edge as FlowEdgeBase, Node as FlowNodeBase } from "@xyflow/react";
import type {
  Edge as WorkflowEdge,
  EdgeCondition,
  Workflow,
} from "@hermes-workflows/core/schema/workflow.ts";
import type { WorkflowNode } from "@hermes-workflows/core/schema/nodes.ts";
import type { UiLayout, Viewport } from "@hermes-workflows/core/schema/ui.ts";

/** Data carried on each canvas node — the full workflow node, for the inspector. */
export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
}

/** Data carried on each canvas edge — the structured edge condition / fallback. */
export interface WorkflowEdgeData extends Record<string, unknown> {
  condition?: EdgeCondition;
  fallback?: boolean;
  /** Transient: the pointer is over this edge. Set only on the render-time
   *  overlay ({@link hoverEdge}), never on the persisted edge model, so it
   *  drives the blue hover highlight without dirtying the graph. */
  hovered?: boolean;
}

export type FlowNode = FlowNodeBase<WorkflowNodeData>;
export type FlowEdge = FlowEdgeBase<WorkflowEdgeData>;

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: Viewport;
}

export interface WorkflowGraph {
  workflow: Workflow;
  ui?: UiLayout;
}

/** The shared node type key; T3 ships one generic renderer, T4 adds per-type. */
export const WORKFLOW_NODE_TYPE = "workflow";

/** The custom edge type key: a labeled, colored edge that makes a branch's cause
 *  legible (vs a neutral plain fan-out edge). */
export const WORKFLOW_EDGE_TYPE = "workflow";

/** A node's outgoing branch points. The handle an edge LEAVES FROM encodes its
 *  condition, so the branching cause is visible at the source: dragging from the
 *  `failure` handle gives the edge `node_status=failure` automatically, and
 *  several edges out of the single `out` handle read as a parallel fan-out. */
export type SourceHandleKind =
  | "out"
  | "success"
  | "failure"
  | "approved"
  | "rejected"
  | "needs_changes"
  | "else";

export type HandleTone = "plain" | "success" | "failure" | "review" | "else";

export interface SourceHandleSpec {
  id: SourceHandleKind;
  label: string;
  tone: HandleTone;
}

const STATUS_HANDLES: SourceHandleSpec[] = [
  { id: "success", label: "success", tone: "success" },
  { id: "failure", label: "failure", tone: "failure" },
  { id: "else", label: "else", tone: "else" },
  { id: "out", label: "always", tone: "plain" },
];

const REVIEW_HANDLES: SourceHandleSpec[] = [
  { id: "approved", label: "approved", tone: "review" },
  { id: "rejected", label: "rejected", tone: "review" },
  { id: "needs_changes", label: "needs", tone: "review" },
  { id: "else", label: "else", tone: "else" },
  { id: "out", label: "always", tone: "plain" },
];

// A pass-through node (a Prompt node) has a single plain output: it does no
// work and never branches, so it exposes only the `out` handle.
const PASS_HANDLES: SourceHandleSpec[] = [{ id: "out", label: "out", tone: "plain" }];

/** The source handles a node type CAN expose (full ordered set). A `human_review`
 *  branches on its review decision; a `prompt` is a single-output pass-through;
 *  every other non-terminal node branches on its own success/failure outcome.
 *  `finish` is terminal and has none. */
export function sourceHandlesFor(type: string): SourceHandleSpec[] {
  if (type === "finish") return [];
  if (type === "prompt") return PASS_HANDLES;
  if (type === "human_review") return REVIEW_HANDLES;
  return STATUS_HANDLES;
}

/** The handles a node shows BY DEFAULT: its two primary outcomes (success/failure,
 *  or approved/rejected). The rest (the other review decision, "else", "always")
 *  are added on demand. */
export function defaultHandleIds(type: string): SourceHandleKind[] {
  return sourceHandlesFor(type)
    .slice(0, 2)
    .map((h) => h.id);
}

/** The handles a node actually renders: its defaults, plus any already used by an
 *  outgoing edge (so an existing conditioned/fallback/plain edge stays anchored),
 *  plus any the operator added via the "+" affordance - in canonical order, no
 *  duplicates. */
export function shownHandleSpecs(
  type: string,
  used: Iterable<string> = [],
  added: Iterable<string> = [],
): SourceHandleSpec[] {
  const show = new Set<string>([...defaultHandleIds(type), ...used, ...added]);
  return sourceHandlesFor(type).filter((h) => show.has(h.id));
}

/** The next outcome a node could add (first canonical handle not already shown),
 *  or null when every outcome is shown - so the "+" affordance disables and a
 *  handle can never be added twice. */
export function nextAddableHandleId(
  type: string,
  shownIds: Iterable<string>,
): SourceHandleKind | null {
  const shown = new Set<string>(shownIds);
  return sourceHandlesFor(type).find((h) => !shown.has(h.id))?.id ?? null;
}

/** The source handle that displays an edge's condition/fallback. A cross-node
 *  `node_status` (advanced: branch on ANOTHER node's outcome) has no own-outcome
 *  handle, so it leaves the plain `out` handle and relies on the edge label. */
export function edgeSourceHandle(
  data: WorkflowEdgeData | undefined,
  sourceId: string,
): SourceHandleKind {
  if (data?.fallback) return "else";
  const c = data?.condition;
  if (c === undefined) return "out";
  if (c.type === "review_status") return c.equals;
  if (c.type === "node_status" && c.node === sourceId) return c.equals;
  return "out";
}

/** Edge condition/fallback data implied by the handle an edge was drawn from. */
export function handleToEdgeData(
  handle: string | null | undefined,
  sourceId: string,
): WorkflowEdgeData {
  switch (handle) {
    case "success":
    case "failure":
      return { condition: { type: "node_status", node: sourceId, equals: handle } };
    case "approved":
    case "rejected":
    case "needs_changes":
      return { condition: { type: "review_status", equals: handle } };
    case "else":
      return { fallback: true };
    default:
      return {};
  }
}

/** Render a snake_case outcome id as legible canvas text (needs_changes -> needs changes). */
function displayOutcomeLabel(value: string): string {
  return value.replace(/_/g, " ");
}

/** A short, legible label for an edge's branch cause (empty for a plain edge). */
export function edgeConditionLabel(data: WorkflowEdgeData | undefined, sourceId: string): string {
  if (data?.fallback) return "else";
  const c = data?.condition;
  if (c === undefined) return "";
  const outcome = displayOutcomeLabel(c.equals);
  if (c.type === "review_status") return outcome;
  return c.node === sourceId ? outcome : `${outcome} of ${c.node}`;
}

/** The visual tone for an edge's branch cause, matching the source handle tones. */
export function edgeTone(data: WorkflowEdgeData | undefined): HandleTone {
  if (data?.fallback) return "else";
  const c = data?.condition;
  if (c === undefined) return "plain";
  if (c.type === "review_status") return "review";
  return c.equals === "failure" ? "failure" : "success";
}

// zIndex for the hovered edge. xyflow renders edges below nodes by default; an
// edge whose zIndex exceeds the nodes' lifts into an SVG layer above them, so a
// pointed-at edge becomes followable end to end in a dense graph (t_c8e0bd91).
export const HOVERED_EDGE_Z_INDEX = 1000;

/** Render-time overlay: mark `hoveredId` as hovered (blue highlight) and raise
 *  its zIndex above nodes, leaving every other edge untouched. Pure - returns a
 *  new array only when something changes - so hover stays out of the persisted
 *  edge model and never dirties the graph. Returns the input array when nothing
 *  is hovered. */
export function hoverEdge(edges: readonly FlowEdge[], hoveredId: string | null): FlowEdge[] {
  if (hoveredId === null) return edges as FlowEdge[];
  return edges.map((edge) =>
    edge.id === hoveredId
      ? { ...edge, zIndex: HOVERED_EDGE_Z_INDEX, data: { ...edge.data, hovered: true } }
      : edge,
  );
}

/** Human-readable label for a workflow node type, shared by the canvas node and
 *  the editor modal so the technical type (`agent_task`) shows as "Agent task". */
export const NODE_TYPE_LABEL: Record<string, string> = {
  agent_task: "Agent task",
  script: "Script",
  condition: "Condition",
  human_review: "Human review",
  finish: "Finish",
  wait: "Wait",
  prompt: "Prompt",
};

export function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABEL[type] ?? type;
}

/** The node's secondary info line: an agent_task shows `profile · model`; other
 *  node types have no extra detail. Shared by the editor and run node views so
 *  the run canvas keeps the same info line and only adds a status line. */
export function nodeMetaLine(node: WorkflowNode): string {
  if (node.type !== "agent_task") return "";
  return [node.profile, node.model].filter((v): v is string => Boolean(v)).join(" · ");
}

function positionFor(
  id: string,
  index: number,
  layout: Map<string, { x: number; y: number }>,
): { x: number; y: number } {
  const known = layout.get(id);
  if (known) return { x: known.x, y: known.y };
  // Deterministic fallback so an un-laid-out spec still renders sensibly.
  return { x: index * 220, y: 0 };
}

export function workflowToFlow(workflow: Workflow, ui?: UiLayout): FlowGraph {
  const layout = new Map<string, { x: number; y: number }>();
  for (const entry of ui?.xyflow?.nodes ?? []) {
    layout.set(entry.id, { x: entry.x, y: entry.y });
  }

  const nodes: FlowNode[] = workflow.nodes.map((node, index) => ({
    id: node.id,
    type: WORKFLOW_NODE_TYPE,
    position: positionFor(node.id, index, layout),
    data: { node },
  }));

  const edges: FlowEdge[] = workflow.edges.map((edge, index) => {
    const data: WorkflowEdgeData = {};
    if (edge.condition !== undefined) data.condition = edge.condition;
    if (edge.fallback !== undefined) data.fallback = edge.fallback;
    return {
      id: `e${index}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      // Leave from the handle that encodes the condition so the branch cause is
      // visible at the source point; the custom edge type adds a legible label.
      sourceHandle: edgeSourceHandle(data, edge.from),
      type: WORKFLOW_EDGE_TYPE,
      data,
    };
  });

  const graph: FlowGraph = { nodes, edges };
  const viewport = ui?.xyflow?.viewport;
  if (viewport) graph.viewport = viewport;
  return graph;
}

function toWorkflowEdge(edge: FlowEdge): WorkflowEdge {
  const result: WorkflowEdge = { from: edge.source, to: edge.target };
  const condition = edge.data?.condition;
  const fallback = edge.data?.fallback;
  if (condition !== undefined) result.condition = condition;
  if (fallback !== undefined) result.fallback = fallback;
  return result;
}

export function flowToWorkflow(
  base: Workflow,
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  viewport?: Viewport,
): WorkflowGraph {
  const workflow: Workflow = {
    ...base,
    nodes: nodes.map((node) => node.data.node),
    edges: edges.map(toWorkflowEdge),
  };

  const ui: UiLayout = {
    xyflow: {
      nodes: nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
    },
  };
  if (viewport && ui.xyflow) ui.xyflow.viewport = viewport;

  return { workflow, ui };
}
