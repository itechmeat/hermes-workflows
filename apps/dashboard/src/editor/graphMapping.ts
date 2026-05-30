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
