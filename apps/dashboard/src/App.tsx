import { useCallback, useEffect, useMemo, useState } from "react";
import "./ui/theme.css";
import { getApiClient, getBasePath } from "./host";
import type { WorkflowsApi } from "./api/client";
import type { O2BStatus, SpecDetail } from "./api/types";
import { TemplatesPage } from "./pages/TemplatesPage";
import { RunsPage } from "./pages/RunsPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FlowEditor } from "./editor/FlowEditor";
import { RunInspector } from "./run/RunInspector";
import { useFillHeight } from "./ui/useFillHeight";
import { HeaderSlotsProvider, PluginHeader, type NavItem } from "./ui/PluginHeader";
import { ClockIcon, LayersIcon, PlayIcon, SlidersIcon } from "./ui/icons";

type View =
  | { name: "templates" }
  | { name: "runs" }
  | { name: "schedules" }
  | { name: "settings" }
  | { name: "editor"; id: string }
  | { name: "inspector"; runId: string };

export interface AppProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

const NAV: NavItem[] = [
  { key: "templates", label: "Workflows", icon: <LayersIcon /> },
  { key: "runs", label: "Runs", icon: <PlayIcon /> },
  { key: "schedules", label: "Schedules", icon: <ClockIcon /> },
  { key: "settings", label: "Settings", icon: <SlidersIcon /> },
];

/** Which nav item is highlighted for a given view (editor/inspector trace back
 *  to the section they were opened from). */
function activeNavKey(view: View): string {
  if (view.name === "editor") return "templates";
  if (view.name === "inspector") return "runs";
  return view.name;
}

/** Parse the URL hash into a view, so a deep link / refresh restores the page. */
function parseHash(): View {
  const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "");
  if (h === "runs") return { name: "runs" };
  if (h === "schedules") return { name: "schedules" };
  if (h === "settings") return { name: "settings" };
  if (h.startsWith("editor/")) return { name: "editor", id: decodeURIComponent(h.slice(7)) };
  if (h.startsWith("run/")) return { name: "inspector", runId: decodeURIComponent(h.slice(4)) };
  return { name: "templates" };
}

function viewToHash(view: View): string {
  switch (view.name) {
    case "runs":
      return "runs";
    case "schedules":
      return "schedules";
    case "settings":
      return "settings";
    case "editor":
      return `editor/${encodeURIComponent(view.id)}`;
    case "inspector":
      return `run/${encodeURIComponent(view.runId)}`;
    default:
      return "workflows";
  }
}

// Plugin root: one plugin header (section nav + Open Second Brain indicator + a
// portal slot for the active view's title/actions) over the Templates list, the
// flow editor, and the run inspector. The host renders this as an ordinary
// component (no createRoot of our own). View state is mirrored to the URL hash.
export function App({ client }: AppProps): React.ReactElement {
  const api = client ?? getApiClient();
  const basePath = useMemo(() => getBasePath(), []);
  const [view, setView] = useState<View>(() => parseHash());
  const [o2b, setO2b] = useState<O2BStatus | null>(null);
  const [leftHost, setLeftHost] = useState<HTMLElement | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const rootRef = useFillHeight();

  // Navigate: update state and push a hash entry so back/forward works.
  const go = useCallback((next: View) => {
    setView(next);
    const hash = `#${viewToHash(next)}`;
    if (typeof window !== "undefined" && window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
  }, []);

  // Sync view when the hash changes (browser back/forward, manual edit).
  useEffect(() => {
    const onHash = (): void => setView(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let active = true;
    api
      .o2bStatus()
      .then((status) => {
        if (active) setO2b(status);
      })
      .catch(() => {
        // A failed probe is unknown, not "not installed": asserting the latter
        // would point the indicator at the external repo on a transient error.
        if (active) setO2b(null);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const slots = useMemo(() => ({ leftHost, actionsHost }), [leftHost, actionsHost]);

  return (
    <div className="hw-root hw-shell" ref={rootRef}>
      <PluginHeader
        nav={NAV}
        activeKey={activeNavKey(view)}
        onNavigate={(key) => go({ name: key } as View)}
        o2bConnected={o2b?.connected ?? null}
        o2bInstalled={o2b?.installed ?? null}
        o2bBasePath={basePath}
        leftRef={setLeftHost}
        actionsRef={setActionsHost}
      />
      <main className="hw-main">
        <HeaderSlotsProvider value={slots}>
          {view.name === "templates" && (
            <TemplatesPage
              client={api}
              onOpen={(id) => go({ name: "editor", id })}
              onOpenRun={(runId) => go({ name: "inspector", runId })}
              onCreated={(id) => go({ name: "editor", id })}
            />
          )}
          {view.name === "runs" && (
            <RunsPage
              client={api}
              onOpenRun={(runId) => go({ name: "inspector", runId })}
              onOpenWorkflow={(id) => go({ name: "editor", id })}
            />
          )}
          {view.name === "schedules" && <SchedulesPage client={api} />}
          {view.name === "settings" && <SettingsPage client={api} />}
          {view.name === "editor" && (
            <EditorLoader
              id={view.id}
              client={api}
              onBack={() => go({ name: "templates" })}
              onOpenRun={(runId) => go({ name: "inspector", runId })}
            />
          )}
          {view.name === "inspector" && <RunInspector runId={view.runId} client={api} />}
        </HeaderSlotsProvider>
      </main>
    </div>
  );
}

// Loads a workflow's full graph before handing it to the editor.
function EditorLoader({
  id,
  client,
  onBack,
  onOpenRun,
}: {
  id: string;
  client: WorkflowsApi;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
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

  if (error !== null) return <p className="hw-page">{error}</p>;
  if (detail === null) return <p className="hw-page">Loading workflow…</p>;
  return <FlowEditor detail={detail} client={client} onBack={onBack} onOpenRun={onOpenRun} />;
}
