import { useState } from "react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// T0 spike App: a minimal @xyflow/react canvas. This proves the bundle shape
// (host-React shim + bundled react-dom) renders a real xyflow canvas. The full
// editor (palette, inspector, validation, run inspector) lands in later tasks.
const initialNodes: Node[] = [
  { id: "trigger", position: { x: 0, y: 0 }, data: { label: "Trigger" } },
  { id: "finish", position: { x: 220, y: 120 }, data: { label: "Finish" } },
];

const initialEdges: Edge[] = [{ id: "trigger->finish", source: "trigger", target: "finish" }];

export function App(): React.ReactElement {
  const [nodes] = useState<Node[]>(initialNodes);
  const [edges] = useState<Edge[]>(initialEdges);

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 400 }}>
      <ReactFlow nodes={nodes} edges={edges} fitView />
    </div>
  );
}
