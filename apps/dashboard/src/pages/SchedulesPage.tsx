import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { ScheduleListItem } from "../api/types";

export interface SchedulesPageProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: ScheduleListItem[] };

/** ISO timestamp → readable local string, or a dash when unset. */
function formatIso(value: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString();
}

export function SchedulesPage({ client }: SchedulesPageProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    api
      .listSchedules()
      .then((items) => {
        if (active) setState({ kind: "ready", items });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [api, reloadKey]);

  // Run a client action, report it, and refresh the list on success.
  const act = useCallback(
    (verb: string, id: string, call: () => Promise<unknown>) => {
      setMessage(`${verb} ${id}…`);
      call()
        .then(() => {
          setMessage(`${verb} ${id} ✓`);
          reload();
        })
        .catch((err: unknown) =>
          setMessage(err instanceof Error ? err.message : `Failed: ${verb} ${id}`),
        );
    },
    [reload],
  );

  const handleEdit = useCallback(
    (s: ScheduleListItem) => {
      const cron = window.prompt(`New cron expression for ${s.workflow_id}`, s.cron_expression ?? "");
      if (!cron) return;
      act("Edit", s.hermes_cron_id, () => api.editSchedule(s.hermes_cron_id, cron));
    },
    [act, api],
  );

  const handleDelete = useCallback(
    (s: ScheduleListItem) => {
      if (!window.confirm(`Delete the schedule for "${s.workflow_id}"? This cannot be undone.`)) return;
      act("Delete", s.hermes_cron_id, () => api.deleteSchedule(s.hermes_cron_id));
    },
    [act, api],
  );

  if (state.kind === "loading") {
    return <p style={{ padding: 16 }}>Loading schedules…</p>;
  }
  if (state.kind === "error") {
    return <p style={{ padding: 16 }}>Failed to load schedules.</p>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h2 style={{ marginRight: "auto" }}>Schedules</h2>
      </div>
      {message !== null && (
        <p role="status" className="hw-status">
          {message}
        </p>
      )}
      {state.items.length === 0 ? (
        <p>No schedules yet. Deploy a cron-triggered workflow to create one.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cell}>Workflow</th>
              <th style={cell}>Cron expression</th>
              <th style={cell}>Timezone</th>
              <th style={cell}>Enabled</th>
              <th style={cell}>Last run</th>
              <th style={cell}>Next run</th>
              <th style={cell}>Hermes Cron ID</th>
              <th style={cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((s) => (
              <tr key={s.hermes_cron_id}>
                <td style={cell}>{s.workflow_id}</td>
                <td style={cell}>
                  <code>{s.cron_expression ?? "—"}</code>
                </td>
                <td style={cell}>{s.timezone}</td>
                <td style={cell}>
                  <span className={`hw-badge hw-badge--${s.enabled ? "completed" : "cancelled"}`}>
                    {s.enabled ? "on" : "paused"}
                  </span>
                </td>
                <td style={cell}>{formatIso(s.last_run)}</td>
                <td style={cell}>{formatIso(s.next_run)}</td>
                <td style={cell}>
                  <code>{s.hermes_cron_id}</code>
                </td>
                <td style={cell}>
                  <span className="hw-actions">
                    <button
                      type="button"
                      className="hw-btn hw-btn--sm"
                      onClick={() => act("Pause", s.hermes_cron_id, () => api.pauseSchedule(s.hermes_cron_id))}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="hw-btn hw-btn--sm"
                      onClick={() => act("Resume", s.hermes_cron_id, () => api.resumeSchedule(s.hermes_cron_id))}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="hw-btn hw-btn--sm"
                      onClick={() => act("Run", s.hermes_cron_id, () => api.runScheduleNow(s.hermes_cron_id))}
                    >
                      Run now
                    </button>
                    <button type="button" className="hw-btn hw-btn--sm" onClick={() => handleEdit(s)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="hw-btn hw-btn--sm hw-btn--danger"
                      onClick={() => handleDelete(s)}
                    >
                      Delete
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

const cell: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 12px 4px 0",
  borderBottom: "1px solid var(--border, #2a2a2a)",
  whiteSpace: "nowrap",
};
