import type { NodeType } from "../api/types";

const NODE_TYPES: { type: NodeType; label: string }[] = [
  { type: "agent_task", label: "Agent task" },
  { type: "condition", label: "Condition" },
  { type: "human_review", label: "Human review" },
  { type: "finish", label: "Finish" },
];

export interface NodePaletteProps {
  onAdd: (type: NodeType) => void;
}

// Left rail: add a node of each type to the canvas.
export function NodePalette({ onAdd }: NodePaletteProps): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, minWidth: 140 }}>
      <div style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase" }}>Add node</div>
      {NODE_TYPES.map(({ type, label }) => (
        <button key={type} type="button" onClick={() => onAdd(type)}>
          {label}
        </button>
      ))}
    </div>
  );
}
