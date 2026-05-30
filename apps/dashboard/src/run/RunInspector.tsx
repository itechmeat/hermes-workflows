import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { RunState, SpecDetail } from "../api/types";
import { applyRunStatus, isTerminalRun } from "./runView";
import { RunNodeView } from "./RunNodeView";
import { WORKFLOW_NODE_TYPE } from "../editor/graphMapping";

export interface RunInspectorProps {
  runId: string;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  /** Poll interval while the run is active. */
  pollMs?: number;
}

export function RunInspector({ runId, client, pollMs = 2000 }: RunInspectorProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [run, setRun] = useState<RunState | null>(null);
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodeTypes = useMemo(() => ({ [WORKFLOW_NODE_TYPE]: RunNodeView }), []);

  // Initial load: the run plus its workflow graph (static for the run's life).
  useEffect(() => {
    let active = true;
    setRun(null);
    setDetail(null);
    setError(null);
    api
      .getRun(runId)
      .then(async (loaded) => {
        if (!active) return;
        setRun(loaded);
        const workflow = await api.getWorkflow(loaded.workflow_id);
        if (active) setDetail(workflow);
      })
      .catch(() => {
        if (active) setError("Failed to load run.");
      });
    return () => {
      active = false;
    };
  }, [api, runId]);

  // Poll only while the run is active; stop once it reaches a terminal state.
  const status = run?.status;
  useEffect(() => {
    if (status === undefined || isTerminalRun(status)) return undefined;
    const handle = setInterval(() => {
      api
        .getRun(runId)
        .then(setRun)
        .catch(() => {});
    }, pollMs);
    return () => clearInterval(handle);
  }, [api, runId, status, pollMs]);

  const cancel = useCallback(() => {
    api
      .cancelRun(runId)
      .then(setRun)
      .catch(() => {});
  }, [api, runId]);

  const retry = useCallback(
    (node?: string) => {
      api
        .retryRun(runId, node)
        .then(setRun)
        .catch(() => {});
    },
    [api, runId],
  );

  if (error !== null) return <p style={{ padding: 16 }}>{error}</p>;
  if (run === null || detail === null) return <p style={{ padding: 16 }}>Loading run…</p>;

  const { nodes, edges } = applyRunStatus(detail, run);
  const selected = selectedNodeId === null ? undefined : run.nodes[selectedNodeId];
  const terminal = isTerminalRun(run.status);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
        <strong>{run.run_id}</strong>
        <span role="status">{run.status}</span>
        <button type="button" onClick={cancel} disabled={terminal}>
          Cancel
        </button>
        <button type="button" onClick={() => retry()}>
          Retry run
        </button>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 400 }}>
        <div style={{ flex: 1, minHeight: 400 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <div style={{ minWidth: 240, padding: 8 }}>
          <div style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase" }}>Nodes</div>
          <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 12px" }}>
            {Object.values(run.nodes).map((node) => (
              <li key={node.node_id}>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(node.node_id)}
                  style={{ textAlign: "left", width: "100%" }}
                >
                  {node.node_id} — {node.status}
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <div>
              <div>
                <code>{selected.node_id}</code>
              </div>
              <p>Status: {selected.status}</p>
              {selected.outcome !== undefined && <p>Outcome: {selected.outcome}</p>}
              {selected.output !== undefined && (
                <pre style={{ whiteSpace: "pre-wrap" }}>{selected.output}</pre>
              )}
              {selected.error !== undefined && <p style={{ color: "#e06c6c" }}>{selected.error}</p>}
              <button type="button" onClick={() => retry(selected.node_id)}>
                Retry node
              </button>
            </div>
          ) : (
            <p style={{ opacity: 0.6 }}>Select a node for detail.</p>
          )}
        </div>
      </div>
    </div>
  );
}
