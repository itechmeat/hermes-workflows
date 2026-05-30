import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { Trigger, WorkflowListItem } from "../api/types";

export interface TemplatesPageProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  /** Open a workflow in the editor (wired by the app shell). */
  onOpen: (workflowId: string) => void;
}

function describeTrigger(trigger: Trigger): string {
  return trigger.type === "cron" ? `cron (${trigger.schedule})` : trigger.type;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: WorkflowListItem[] };

export function TemplatesPage({ client, onOpen }: TemplatesPageProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [runMessage, setRunMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listWorkflows()
      .then((items) => {
        if (active) setState({ kind: "ready", items });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [api]);

  const handleRun = useCallback(
    (id: string) => {
      setRunMessage(`Starting ${id}…`);
      api
        .runWorkflow(id)
        .then((result) => setRunMessage(`Started run ${result.run_id}`))
        .catch(() => setRunMessage(`Failed to start ${id}`));
    },
    [api],
  );

  if (state.kind === "loading") {
    return <p style={{ padding: 16 }}>Loading workflows…</p>;
  }
  if (state.kind === "error") {
    return <p style={{ padding: 16 }}>Failed to load workflows.</p>;
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>Workflows</h2>
      {runMessage !== null && <p role="status">{runMessage}</p>}
      {state.items.length === 0 ? (
        <p>No workflows yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cell}>Name</th>
              <th style={cell}>Id</th>
              <th style={cell}>Scope</th>
              <th style={cell}>Trigger</th>
              <th style={cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((item) => (
              <tr key={item.id}>
                <td style={cell}>{item.name}</td>
                <td style={cell}>{item.id}</td>
                <td style={cell}>{item.scope}</td>
                <td style={cell}>{describeTrigger(item.trigger)}</td>
                <td style={cell}>
                  <button type="button" onClick={() => onOpen(item.id)}>
                    Open
                  </button>{" "}
                  <button type="button" onClick={() => handleRun(item.id)}>
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cell: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 12px 4px 0",
  borderBottom: "1px solid var(--border, #2a2a2a)",
};
