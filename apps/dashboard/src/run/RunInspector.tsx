import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { RunState, SpecDetail } from "../api/types";
import { applyRunStatus, isTerminalRun } from "./runView";
import { RunNodeView } from "./RunNodeView";
import { TelemetryDetail } from "./TelemetryDetail";
import { WORKFLOW_NODE_TYPE } from "../editor/graphMapping";
import { Badge, Button } from "../ui/components";
import { useHeaderSlots } from "../ui/PluginHeader";

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
  const slots = useHeaderSlots();

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

  if (error !== null) return <p className="hw-page">{error}</p>;
  if (run === null || detail === null) return <p className="hw-page">Loading run…</p>;

  const { nodes, edges } = applyRunStatus(detail, run);
  const selected = selectedNodeId === null ? undefined : run.nodes[selectedNodeId];
  const terminal = isTerminalRun(run.status);

  const title = (
    <>
      <span className="hw-bar-title">{run.run_id}</span>
      <Badge tone={run.status}>{run.status}</Badge>
    </>
  );
  const actions = (
    <>
      <Button onClick={cancel} disabled={terminal}>
        Cancel
      </Button>
      <Button onClick={() => retry()}>Retry run</Button>
    </>
  );

  return (
    <>
      {slots ? (
        <>
          {slots.leftHost ? createPortal(title, slots.leftHost) : null}
          {slots.actionsHost ? createPortal(actions, slots.actionsHost) : null}
        </>
      ) : (
        <div className="hw-editor-toolbar">
          {title}
          {actions}
        </div>
      )}

      <div className="hw-shell">
      <div className="hw-editor-body">
        <div className="hw-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <div className="hw-run-rail">
          <div className="hw-eyebrow">Nodes</div>
          <ul className="hw-navlist">
            {Object.values(run.nodes).map((node) => (
              <li key={node.node_id}>
                <Button onClick={() => setSelectedNodeId(node.node_id)}>
                  {node.node_id} — {node.status}
                </Button>
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
              {selected.output !== undefined && <pre className="hw-output">{selected.output}</pre>}
              {selected.error !== undefined && <p className="hw-error">{selected.error}</p>}
              {selected.telemetry !== undefined && (
                <TelemetryDetail
                  telemetry={selected.telemetry}
                  nodeActive={selected.status === "scheduled" || selected.status === "running"}
                />
              )}
              <Button onClick={() => retry(selected.node_id)}>Retry node</Button>
            </div>
          ) : (
            <p className="hw-note">Select a node for detail.</p>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
