import { createContext, useContext } from "react";

// Lets a canvas node trigger the editor modal for itself without threading a
// callback through node data. FlowEditor provides the opener; WorkflowNodeView
// consumes it for its open button. Null outside the provider (e.g. tests that
// render a node in isolation), in which case the button is hidden.
const NodeOpenContext = createContext<((id: string) => void) | null>(null);

export const NodeOpenProvider = NodeOpenContext.Provider;

export function useNodeOpen(): ((id: string) => void) | null {
  return useContext(NodeOpenContext);
}
