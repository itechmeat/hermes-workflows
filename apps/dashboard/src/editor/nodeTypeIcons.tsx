// The single source of node-type -> icon, shared by the header's add-node menu
// (FlowEditor) and the canvas node renderers (WorkflowNodeView, RunNodeView), so
// the picker and the placed node show the same glyph. Labels are shared
// separately by `nodeTypeLabel` in graphMapping; that module is deliberately
// React-free, so the JSX icon map lives here next to it rather than inside it.
import type { NodeType } from "../api/types";
import {
  BranchIcon,
  ClockIcon,
  CpuIcon,
  EyeIcon,
  FlagIcon,
  PromptIcon,
  TerminalIcon,
} from "../ui/icons";

export const NODE_TYPE_ICON: Record<NodeType, React.ReactElement> = {
  agent_task: <CpuIcon />,
  script: <TerminalIcon />,
  condition: <BranchIcon />,
  human_review: <EyeIcon />,
  finish: <FlagIcon />,
  wait: <ClockIcon />,
  prompt: <PromptIcon />,
};

/** The icon for a node type. Falls back to the agent_task glyph for an unknown
 *  type so a forward-compatible spec still renders a node header. */
export function nodeTypeIcon(type: string): React.ReactElement {
  return NODE_TYPE_ICON[type as NodeType] ?? NODE_TYPE_ICON.agent_task;
}
