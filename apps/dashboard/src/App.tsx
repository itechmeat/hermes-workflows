import { useEffect, useState } from "react";
import "./ui/theme.css";
import { getApiClient } from "./host";
import type { WorkflowsApi } from "./api/client";
import type { SpecDetail } from "./api/types";
import { TemplatesPage } from "./pages/TemplatesPage";
import { RunsPage } from "./pages/RunsPage";
import { FlowEditor } from "./editor/FlowEditor";
import { RunInspector } from "./run/RunInspector";

type View =
  | { name: "templates" }
  | { name: "runs" }
  | { name: "editor"; id: string }
  | { name: "inspector"; runId: string };

export interface AppProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

// Plugin root: a tab shell over the Templates list, the flow editor, and the run
// inspector, plus the OpenSecondBrain connection badge. The host renders this as
// an ordinary component (no createRoot of our own).
export function App({ client }: AppProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [view, setView] = useState<View>({ name: "templates" });
  const [o2b, setO2b] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    api
      .o2bStatus()
      .then((status) => {
        if (active) setO2b(status.connected);
      })
      .catch(() => {
        if (active) setO2b(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480 }}>
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid var(--border, #2a2a2a)",
        }}
      >
        <button type="button" className="hw-btn hw-btn--sm" onClick={() => setView({ name: "templates" })}>
          Workflows
        </button>
        <button type="button" className="hw-btn hw-btn--sm" onClick={() => setView({ name: "runs" })}>
          Runs
        </button>
        {view.name === "editor" && <span>Editing {view.id}</span>}
        {view.name === "inspector" && <span>Run {view.runId}</span>}
        <span style={{ marginLeft: "auto" }}>
          OpenSecondBrain: {o2b === null ? "…" : o2b ? "connected" : "not connected"}
        </span>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        {view.name === "templates" && (
          <TemplatesPage
            client={api}
            onOpen={(id) => setView({ name: "editor", id })}
            onOpenRun={(runId) => setView({ name: "inspector", runId })}
            onCreated={(id) => setView({ name: "editor", id })}
          />
        )}
        {view.name === "runs" && (
          <RunsPage client={api} onOpenRun={(runId) => setView({ name: "inspector", runId })} />
        )}
        {view.name === "editor" && <EditorLoader id={view.id} client={api} />}
        {view.name === "inspector" && <RunInspector runId={view.runId} client={api} />}
      </main>
    </div>
  );
}

// Loads a workflow's full graph before handing it to the editor.
function EditorLoader({ id, client }: { id: string; client: WorkflowsApi }): React.ReactElement {
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    client
      .getWorkflow(id)
      .then((loaded) => {
        if (active) setDetail(loaded);
      })
      .catch(() => {
        if (active) setError("Failed to load workflow.");
      });
    return () => {
      active = false;
    };
  }, [client, id]);

  if (error !== null) return <p style={{ padding: 16 }}>{error}</p>;
  if (detail === null) return <p style={{ padding: 16 }}>Loading workflow…</p>;
  return <FlowEditor detail={detail} client={client} />;
}
