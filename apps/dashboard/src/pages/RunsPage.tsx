import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
import { downloadTextFile } from "../templates/download";
import { formatEpochSeconds } from "../ui/format";
import type { RunScope, WorkflowsApi } from "../api/client";
import type { RunStatus, RunSummary } from "../api/types";

export interface RunsPageProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  /** Open the run inspector (wired by the app shell). */
  onOpenRun: (runId: string) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: RunSummary[] };

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${mins}m ${rem}s`;
}

export function RunsPage({ client, onOpenRun }: RunsPageProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeOnly, setActiveOnly] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    const scope: RunScope = activeOnly ? "active" : "all";
    api
      .listRuns(scope)
      .then((items) => {
        if (active) setState({ kind: "ready", items });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
    // reloadKey re-fetches after an action without flashing the loading state.
  }, [api, activeOnly, reloadKey]);

  const handleCancel = useCallback(
    (id: string) => {
      setMessage(`Cancelling ${id}…`);
      api
        .cancelRun(id)
        .then(() => {
          setMessage(`Cancelled ${id}`);
          reload();
        })
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed to cancel ${id}`),
        );
    },
    [api, reload],
  );

  const handleRetryRun = useCallback(
    (id: string) => {
      setMessage(`Retrying ${id}…`);
      api
        .retryRun(id)
        .then(() => {
          setMessage(`Retried ${id}`);
          reload();
        })
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed to retry ${id}`),
        );
    },
    [api, reload],
  );

  const handleRetryNode = useCallback(
    (run: RunSummary) => {
      const node = window.prompt(`Node id to retry in ${run.run_id}`, run.current_node ?? "");
      if (!node) return;
      setMessage(`Retrying ${node} in ${run.run_id}…`);
      api
        .retryRun(run.run_id, node)
        .then(() => {
          setMessage(`Retried ${node} in ${run.run_id}`);
          reload();
        })
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed to retry ${node}`),
        );
    },
    [api, reload],
  );

  const handleExport = useCallback(
    (id: string) => {
      api
        .exportRunLogs(id)
        .then(({ filename, json }) =>
          downloadTextFile(filename, JSON.stringify(json, null, 2), "application/json"),
        )
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed to export ${id}`),
        );
    },
    [api],
  );

  if (state.kind === "loading") {
    return <p style={{ padding: 16 }}>Loading runs…</p>;
  }
  if (state.kind === "error") {
    return <p style={{ padding: 16 }}>Failed to load runs.</p>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h2 style={{ marginRight: "auto" }}>Runs</h2>
        <label className="hw-checkbox">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />{" "}
          Active only
        </label>
      </div>
      {message !== null && (
        <p role="status" className="hw-status">
          {message}
        </p>
      )}
      {state.items.length === 0 ? (
        <p>No runs yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cell}>Run ID</th>
              <th style={cell}>Workflow</th>
              <th style={cell}>Project</th>
              <th style={cell}>Status</th>
              <th style={cell}>Current node</th>
              <th style={cell}>Started</th>
              <th style={cell}>Finished</th>
              <th style={cell}>Duration</th>
              <th style={cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((r) => (
              <tr key={r.run_id}>
                <td style={cell}>{r.run_id}</td>
                <td style={cell}>{r.workflow_id}</td>
                <td style={cell}>{r.project_id ?? "—"}</td>
                <td style={cell}>
                  <StatusBadge status={r.status} />
                </td>
                <td style={cell}>{r.current_node ?? "—"}</td>
                <td style={cell}>{formatEpochSeconds(r.started_at)}</td>
                <td style={cell}>{formatEpochSeconds(r.finished_at)}</td>
                <td style={cell}>{formatDuration(r.duration)}</td>
                <td style={cell}>
                  <span className="hw-actions">
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => onOpenRun(r.run_id)}>
                      Open
                    </button>
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => handleCancel(r.run_id)}>
                      Cancel
                    </button>
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => handleRetryNode(r)}>
                      Retry node
                    </button>
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => handleRetryRun(r.run_id)}>
                      Retry run
                    </button>
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => handleExport(r.run_id)}>
                      Export
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }): React.ReactElement {
  return <span className={`hw-badge hw-badge--${status}`}>{status}</span>;
}

const cell: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 12px 4px 0",
  borderBottom: "1px solid var(--border, #2a2a2a)",
  whiteSpace: "nowrap",
};
