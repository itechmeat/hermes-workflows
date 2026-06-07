import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { SpecDetail } from "../api/types";
import { applyRunStatus, isTerminalRun } from "./runView";
import { CANVAS_NODE_TYPES } from "./canvasNodeTypes";
import { errorMessage, RUN_POLL_MS, useRunPolling } from "./useRunPolling";
import { TelemetryDetail } from "./TelemetryDetail";
import { Badge, Button } from "../ui/components";
import { useHeaderSlots } from "../ui/PluginHeader";

export interface RunInspectorProps {
  runId: string;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  /** Poll interval while the run is active. */
  pollMs?: number;
}

export function RunInspector({
  runId,
  client,
  pollMs = RUN_POLL_MS,
}: RunInspectorProps): React.ReactElement {
  const api = client ?? getApiClient();
  const { run, pollError, replaceRun } = useRunPolling(api, runId, pollMs);
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Cancel/retry failure; cleared by the next attempt, shown next to the title.
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const slots = useHeaderSlots();

  // The workflow graph is static for the run's life: load it once the run
  // reveals its workflow id.
  const workflowId = run?.workflow_id;
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (workflowId === undefined) return undefined;
    let active = true;
    api
      .getWorkflow(workflowId)
      .then((workflow) => {
        if (active) setDetail(workflow);
      })
      .catch((error: unknown) => {
        if (active) setDetailError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [api, workflowId]);

  const cancel = useCallback(() => {
    setActionError(null);
    api
      .cancelRun(runId)
      .then(replaceRun)
      .catch((error: unknown) => setActionError(`Cancel failed: ${errorMessage(error)}`));
  }, [api, runId, replaceRun]);

  const retry = useCallback(
    (node?: string) => {
      setActionError(null);
      api
        .retryRun(runId, node)
        .then(replaceRun)
        .catch((error: unknown) => setActionError(`Retry failed: ${errorMessage(error)}`));
    },
    [api, runId, replaceRun],
  );

  if (run === null && pollError !== null) {
    return (
      <p className="hw-page" role="alert">
        Failed to load run: {pollError}
      </p>
    );
  }
  if (detailError !== null) {
    return (
      <p className="hw-page" role="alert">
        Failed to load workflow: {detailError}
      </p>
    );
  }
  if (run === null || detail === null) return <p className="hw-page">Loading run…</p>;

  const inspectorError = pollError ?? actionError;

  const { nodes, edges } = applyRunStatus(detail, run);
  const selected = selectedNodeId === null ? undefined : run.nodes[selectedNodeId];
  const terminal = isTerminalRun(run.status);

  const title = (
    <>
      <span className="hw-bar-title">{run.run_id}</span>
      <Badge tone={run.status}>{run.status}</Badge>
      {inspectorError !== null && (
        <span role="alert" className="hw-bar-status hw-error">
          {inspectorError}
        </span>
      )}
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
            nodeTypes={CANVAS_NODE_TYPES}
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
