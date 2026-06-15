// Module-level edgeTypes registry (created once, compared by identity by
// ReactFlow - a new object each render re-mounts edges). Mirrors
// CANVAS_NODE_TYPES.
import type { EdgeTypes } from "@xyflow/react";
import { WORKFLOW_EDGE_TYPE } from "../graphMapping";
import { WorkflowEdgeView } from "./WorkflowEdgeView";

export const CANVAS_EDGE_TYPES: EdgeTypes = {
  [WORKFLOW_EDGE_TYPE]: WorkflowEdgeView as EdgeTypes[string],
};
