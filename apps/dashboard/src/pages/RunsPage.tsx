import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
import { downloadTextFile } from "../templates/download";
import { formatEpochSeconds } from "../ui/format";
import { Badge, Menu, PageHeader } from "../ui/components";
import type { RunScope, WorkflowsApi } from "../api/client";
import type { RunSummary } from "../api/types";

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
        .then(({ filename, json, trace, trace_filename }) => {
          downloadTextFile(filename, JSON.stringify(json, null, 2), "application/json");
          // A traced run ships its JSONL timeline as a second file.
          if (trace !== undefined && trace_filename !== undefined) {
            downloadTextFile(trace_filename, trace, "application/jsonl");
          }
        })
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed to export ${id}`),
        );
    },
    [api],
  );

  if (state.kind === "loading") {
    return <p className="hw-page">Loading runs…</p>;
  }
  if (state.kind === "error") {
    return <p className="hw-page">Failed to load runs.</p>;
  }

  return (
    <div className="hw-page">
      <PageHeader
        title="Runs"
        actions={
          <label className="hw-checkbox">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />{" "}
            Active only
          </label>
        }
      />
      {message !== null && (
        <p role="status" className="hw-status">
          {message}
        </p>
      )}
      {state.items.length === 0 ? (
        <p>No runs yet.</p>
      ) : (
        <table className="hw-table hw-table--nowrap">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Workflow</th>
              <th>Project</th>
              <th>Status</th>
              <th>Current node</th>
              <th>Started</th>
              <th>Finished</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((r) => (
              <tr key={r.run_id}>
                <td>{r.run_id}</td>
                <td>{r.workflow_id}</td>
                <td>{r.project_id ?? "—"}</td>
                <td>
                  <Badge tone={r.status}>{r.status}</Badge>
                </td>
                <td>{r.current_node ?? "—"}</td>
                <td>{formatEpochSeconds(r.started_at)}</td>
                <td>{formatEpochSeconds(r.finished_at)}</td>
                <td>{formatDuration(r.duration)}</td>
                <td>{r.total_tokens === null ? "—" : r.total_tokens.toLocaleString("en-US")}</td>
                <td>
                  <Menu
                    size="sm"
                    align="end"
                    label="Actions"
                    items={[
                      { key: "open", label: "Open", onSelect: () => onOpenRun(r.run_id) },
                      { key: "cancel", label: "Cancel", onSelect: () => handleCancel(r.run_id) },
                      { key: "retry-node", label: "Retry node", onSelect: () => handleRetryNode(r) },
                      { key: "retry-run", label: "Retry run", onSelect: () => handleRetryRun(r.run_id) },
                      { key: "export", label: "Export", onSelect: () => handleExport(r.run_id) },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
