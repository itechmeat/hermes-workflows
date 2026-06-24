import { useCallback, useEffect, useRef, useState } from "react";
import { getApiClient } from "../host";
import { downloadTextFile, readTextFile } from "../templates/download";
import { NewWorkflowModal } from "../templates/NewWorkflowModal";
import { isValidSlug } from "../templates/slug";
import { parseWorkflowJsonFile, workflowJsonFile } from "../templates/transfer";
import {
  describeImportNormalization,
  modelKeySet,
  normalizeWorkflowForImport,
  type ImportCatalog,
} from "../templates/normalizeImport";
import { formatEpochSeconds, formatIso, orDash } from "../ui/format";
import { BackendUnavailable, Badge, Button, Menu, PageHeader } from "../ui/components";
import type { WorkflowsApi } from "../api/client";
import type { Trigger, WorkflowListItem } from "../api/types";

export interface TemplatesPageProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  /** Open a workflow in the editor (wired by the app shell). */
  onOpen: (workflowId: string) => void;
  /** Open the run inspector after starting a run (wired by the app shell). */
  onOpenRun?: (runId: string) => void;
  /** Notified with the new id after a create. When wired, the shell navigates
   *  to the editor; otherwise the page just refreshes its own list. */
  onCreated?: (workflowId: string) => void;
}

function describeTrigger(trigger: Trigger): string {
  return trigger.type === "cron" ? `cron (${trigger.schedule})` : trigger.type;
}

/** Fetch the host's models/profiles/skills for import normalization. Each
 *  dimension is resolved independently: a lookup that fails stays `undefined`
 *  so its node field is left untouched (never stripped on a transient error)
 *  and is reported as unverified. */
async function loadImportCatalog(api: WorkflowsApi): Promise<ImportCatalog> {
  const [models, profiles, skills] = await Promise.allSettled([
    api.listModels(),
    api.listProfiles(),
    api.listSkills(),
  ]);
  const catalog: ImportCatalog = {};
  if (models.status === "fulfilled") catalog.models = modelKeySet(models.value);
  if (profiles.status === "fulfilled") catalog.profiles = new Set(profiles.value);
  if (skills.status === "fulfilled") catalog.skills = new Set(skills.value);
  return catalog;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; detail?: string }
  | { kind: "ready"; items: WorkflowListItem[] };

export function TemplatesPage({
  client,
  onOpen,
  onOpenRun,
  onCreated,
}: TemplatesPageProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showNew, setShowNew] = useState(false);
  // The visible Import button proxies a hidden file input (no native file
  // button styling); the input keeps an accessible label for tests/AT.
  const importInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleCreated = useCallback(
    (id: string) => {
      setShowNew(false);
      if (onCreated) onCreated(id);
      else reload();
    },
    [onCreated, reload],
  );

  useEffect(() => {
    let active = true;
    api
      .listWorkflows()
      .then((items) => {
        if (active) setState({ kind: "ready", items });
      })
      .catch((err: unknown) => {
        if (active) {
          setState({ kind: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      active = false;
    };
    // reloadKey re-fetches after a duplicate/delete without resetting to the
    // loading state, so existing rows stay visible during the refresh.
  }, [api, reloadKey]);

  const handleRun = useCallback(
    (id: string) => {
      setRunMessage(`Starting ${id}…`);
      api
        .runWorkflow(id)
        .then((result) => {
          setRunMessage(`Started run ${result.run_id}`);
          onOpenRun?.(result.run_id);
        })
        // Surface the server detail (e.g. the scripts-disabled 409) rather than a
        // generic failure, so the author knows why the run was refused.
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to start ${id}`),
        );
    },
    [api, onOpenRun],
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      const newId = window.prompt(`New id for the copy of "${id}"`, `${id}-copy`);
      if (!newId) return;
      if (!isValidSlug(newId)) {
        setRunMessage(`"${newId}" is not a valid id: letters, digits, hyphen, or underscore only.`);
        return;
      }
      setRunMessage(`Duplicating ${id}…`);
      api
        .getWorkflow(id)
        .then((detail) =>
          api.createWorkflow({
            workflow: { ...detail.workflow, id: newId, name: `${detail.workflow.name} copy` },
            ...(detail.ui !== undefined ? { ui: detail.ui } : {}),
          }),
        )
        .then(() => {
          setRunMessage(`Created ${newId}`);
          reload();
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to duplicate ${id}`),
        );
    },
    [api, reload],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (!window.confirm(`Delete workflow "${id}"? This cannot be undone.`)) return;
      setRunMessage(`Deleting ${id}…`);
      api
        .deleteWorkflow(id)
        .then(() => {
          setRunMessage(`Deleted ${id}`);
          reload();
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to delete ${id}`),
        );
    },
    [api, reload],
  );

  const handleExport = useCallback(
    (id: string) => {
      api
        .exportWorkflow(id)
        .then(({ filename, yaml }) => downloadTextFile(filename, yaml))
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to export ${id}`),
        );
    },
    [api],
  );

  const handleExportJson = useCallback(
    (id: string) => {
      api
        .getWorkflow(id)
        .then((detail) => {
          const { filename, content } = workflowJsonFile(detail);
          downloadTextFile(filename, content, "application/json");
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to export ${id}`),
        );
    },
    [api],
  );

  const handleExportTemplate = useCallback(
    (id: string) => {
      setRunMessage(`Building template for ${id}…`);
      api
        .exportTemplate(id)
        .then((bundle) => {
          // Two artifacts: the de-bound spec and its adaptation guide.
          downloadTextFile(bundle.yaml_filename, bundle.yaml);
          downloadTextFile(bundle.md_filename, bundle.md, "text/markdown");
          setRunMessage(
            `Exported template ${id} (${bundle.human_version})${bundle.cached ? " — from cache" : ""}`,
          );
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to export template ${id}`),
        );
    },
    [api],
  );

  const handleImportFile = useCallback(
    (file: File) => {
      setRunMessage(`Importing ${file.name}…`);
      readTextFile(file)
        // parseWorkflowJsonFile throws the human-readable reason (bad JSON /
        // not a workflow export); everything semantic is core validation via
        // createWorkflow, whose 409/400 detail lands in the same status line.
        .then(async (text) => {
          const parsed = parseWorkflowJsonFile(text);
          // Reset models/profiles/skills this host doesn't have, so a workflow
          // from another environment imports clean instead of carrying dangling
          // references. A failed catalogue lookup leaves that dimension as-is.
          const catalog = await loadImportCatalog(api);
          const { body, resets, unverified } = normalizeWorkflowForImport(parsed, catalog);
          const created = await api.createWorkflow(body);
          return { created, summary: describeImportNormalization(resets, unverified) };
        })
        .then(({ created, summary }) => {
          setRunMessage(
            summary ? `Imported "${created.workflow.id}" (${summary})` : `Imported "${created.workflow.id}"`,
          );
          reload();
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to import ${file.name}`),
        );
    },
    [api, reload],
  );

  const handleToggleEnabled = useCallback(
    (item: WorkflowListItem) => {
      const next = !item.enabled;
      setRunMessage(`${next ? "Enabling" : "Disabling"} ${item.id}…`);
      api
        .setWorkflowEnabled(item.id, next)
        .then(() => {
          setRunMessage(`${next ? "Enabled" : "Disabled"} ${item.id}`);
          reload();
        })
        .catch((err: unknown) =>
          setRunMessage(err instanceof Error ? err.message : `Failed to update ${item.id}`),
        );
    },
    [api, reload],
  );

  if (state.kind === "loading") {
    return <p className="hw-page">Loading workflows…</p>;
  }
  if (state.kind === "error") {
    return <BackendUnavailable resource="workflows" detail={state.detail} />;
  }

  return (
    <div className="hw-page">
      <PageHeader
        title="Workflows"
        actions={
          <>
            <Button onClick={() => importInput.current?.click()}>Import</Button>
            <input
              ref={importInput}
              type="file"
              accept=".json,application/json"
              aria-label="Import workflow JSON"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Reset so picking the same file again (e.g. after resolving
                // an id clash) fires a fresh change event.
                event.target.value = "";
                if (file !== undefined) handleImportFile(file);
              }}
            />
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New workflow
            </Button>
          </>
        }
      />
      {runMessage !== null && (
        <p role="status" className="hw-status">
          {runMessage}
        </p>
      )}
      {showNew && (
        <NewWorkflowModal
          client={api}
          onCreated={handleCreated}
          onCancel={() => setShowNew(false)}
        />
      )}
      {state.items.length === 0 ? (
        <p>No workflows yet.</p>
      ) : (
        <table className="hw-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Scope</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Last run</th>
              <th>Last status</th>
              <th>Next run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((item) => (
              <tr key={item.id} className={item.enabled ? undefined : "hw-row--disabled"}>
                <td>
                  <a
                    className="hw-link"
                    href={`#editor/${encodeURIComponent(item.id)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(item.id);
                    }}
                  >
                    {item.name}
                  </a>
                </td>
                <td>{item.id}</td>
                <td>{item.scope}</td>
                <td>{describeTrigger(item.trigger)}</td>
                <td>
                  <Badge tone={item.enabled ? "enabled" : "disabled"}>
                    {item.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </td>
                <td>{formatEpochSeconds(item.last_run_at)}</td>
                <td>{orDash(item.last_status)}</td>
                <td>{formatIso(item.next_run_at)}</td>
                <td>
                  <Menu
                    size="sm"
                    align="end"
                    label="Actions"
                    items={[
                      { key: "open", label: "Open", onSelect: () => onOpen(item.id) },
                      {
                        key: "run",
                        label: "Run",
                        disabled: !item.enabled,
                        onSelect: () => handleRun(item.id),
                      },
                      {
                        key: "toggle",
                        label: item.enabled ? "Disable" : "Enable",
                        onSelect: () => handleToggleEnabled(item),
                      },
                      { key: "duplicate", label: "Duplicate", onSelect: () => handleDuplicate(item.id) },
                      { key: "export", label: "Export YAML", onSelect: () => handleExport(item.id) },
                      {
                        key: "export-json",
                        label: "Export JSON",
                        onSelect: () => handleExportJson(item.id),
                      },
                      {
                        key: "export-template",
                        label: "Export as template",
                        onSelect: () => handleExportTemplate(item.id),
                      },
                      { key: "delete", label: "Delete", onSelect: () => handleDelete(item.id) },
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
