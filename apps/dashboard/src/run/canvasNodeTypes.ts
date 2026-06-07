// Single module-level nodeTypes registry shared by every canvas. ReactFlow
// compares the registry object by identity and warns (then re-mounts node
// internals) when it changes between renders, so renderer switching is done by
// remapping each node's `type` to one of these keys — the registry object
// itself is created exactly once.
import type { NodeTypes } from "@xyflow/react";
import { WORKFLOW_NODE_TYPE } from "../editor/graphMapping";
import { WorkflowNodeView } from "../editor/nodes/WorkflowNodeView";
import { RUN_NODE_TYPE } from "./runView";
import { RunNodeView } from "./RunNodeView";

export const CANVAS_NODE_TYPES: NodeTypes = {
  [WORKFLOW_NODE_TYPE]: WorkflowNodeView as NodeTypes[string],
  [RUN_NODE_TYPE]: RunNodeView as NodeTypes[string],
};
