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
import { RunLogPanel } from "./RunLogPanel";
import { deriveRunLogEvents, mergeRunLog, type LoggedRunEvent } from "./runLog";
import { Badge, Button, Modal } from "../ui/components";
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
  const [log, setLog] = useState<LoggedRunEvent[]>([]);
  const slots = useHeaderSlots();

  // Drop the prior run's curated log when the inspected run changes without an
  // unmount; otherwise key-dedupe would suppress the new run's `run:started`.
  useEffect(() => {
    setLog([]);
  }, [runId]);

  // Append any newly-observed run-lifecycle events to the curated run log,
  // stamping each with the time it was first seen (kept on later polls).
  useEffect(() => {
    if (run === null) return;
    setLog((prev) => mergeRunLog(prev, deriveRunLogEvents(run), Date.now()));
  }, [run]);

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
  // Source handles each node uses (by an outgoing edge), so the run canvas
  // renders the handles its conditioned/fallback edges leave from and the edges
  // stay anchored.
  const usedHandlesByNode: Record<string, string[]> = {};
  for (const edge of edges) {
    (usedHandlesByNode[edge.source] ??= []).push(edge.sourceHandle ?? "out");
  }
  // Carry the open-detail handler on each node's data: ReactFlow does not
  // propagate React context into custom node components, so a context provider
  // would never reach RunNodeView's open button.
  const canvasNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onSelect: setSelectedNodeId,
      usedHandles: usedHandlesByNode[node.id] ?? [],
    },
  }));
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
              nodes={canvasNodes}
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
            <RunLogPanel events={log} />
          </div>
        </div>
      </div>

      {/* Click a node to inspect it — the detail (status, output, telemetry,
          retry) opens in a modal, mirroring the editor's node inspector, so
          the run view is a clean canvas with its actions in the header. */}
      {selected !== undefined && selectedNodeId !== null && (
        <Modal
          title={selectedNodeId}
          ariaLabel={`Node ${selectedNodeId}`}
          className="hw-node-modal"
          onClose={() => setSelectedNodeId(null)}
          footer={<Button onClick={() => retry(selectedNodeId)}>Retry node</Button>}
        >
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
        </Modal>
      )}
    </>
  );
}
