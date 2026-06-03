import { useCallback, useMemo, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { Scope, ScopeType, Trigger } from "../api/types";
import { buildSeedWorkflow } from "./seed";
import { generateWorkflowId } from "./id";
import { Button, Field, Modal } from "../ui/components";

export interface NewWorkflowModalProps {
  /** Called with the new workflow id once it is created on disk. */
  onCreated: (workflowId: string) => void;
  /** Dismiss without creating. */
  onCancel: () => void;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

function parseProjects(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function buildScope(type: ScopeType, projectsRaw: string): Scope {
  if (type === "global") return { type };
  return { type, projects: parseProjects(projectsRaw) };
}

export function NewWorkflowModal({
  onCreated,
  onCancel,
  client,
}: NewWorkflowModalProps): React.ReactElement {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [name, setName] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("global");
  const [projects, setProjects] = useState("");
  const [triggerType, setTriggerType] = useState<Trigger["type"]>("manual");
  const [schedule, setSchedule] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    // Only `preventDefault` is needed; typed structurally because @types/react
    // marks the `FormEvent` alias deprecated ("doesn't actually exist").
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        setError("Give the workflow a name.");
        return;
      }
      if (triggerType === "cron" && schedule.trim().length === 0) {
        setError("A cron trigger needs a schedule.");
        return;
      }
      // The id is an internal handle (it becomes the on-disk filename), so we
      // generate it rather than asking the user. A fresh id is drawn each submit,
      // so a (vanishingly rare) 409 collision self-resolves on the next attempt.
      const id = generateWorkflowId();
      const trigger: Trigger =
        triggerType === "cron" ? { type: "cron", schedule: schedule.trim() } : { type: "manual" };
      const workflow = buildSeedWorkflow({
        id,
        name: trimmedName,
        scope: buildScope(scopeType, projects),
        trigger,
      });

      setBusy(true);
      setError(null);
      api
        .createWorkflow({ workflow })
        .then(() => onCreated(id))
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Could not create the workflow.");
          setBusy(false);
        });
    },
    [api, name, scopeType, projects, triggerType, schedule, onCreated],
  );

  return (
    <Modal
      title="New workflow"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" form="hw-new-workflow" variant="primary" disabled={busy}>
            Create
          </Button>
        </>
      }
    >
      <form id="hw-new-workflow" onSubmit={submit} className="hw-form">
        <Field label="Name" htmlFor="nw-name">
          <input
            id="nw-name"
            className="hw-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="Scope" htmlFor="nw-scope">
          <select
            id="nw-scope"
            className="hw-select"
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as ScopeType)}
          >
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="projects">projects</option>
          </select>
        </Field>
        {scopeType !== "global" && (
          <Field label="Projects (comma-separated)" htmlFor="nw-projects">
            <input
              id="nw-projects"
              className="hw-input"
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
            />
          </Field>
        )}

        <Field label="Trigger" htmlFor="nw-trigger">
          <select
            id="nw-trigger"
            className="hw-select"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as Trigger["type"])}
          >
            <option value="manual">manual</option>
            <option value="cron">cron</option>
          </select>
        </Field>
        {triggerType === "cron" && (
          <Field label="Schedule (cron)" htmlFor="nw-schedule">
            <input
              id="nw-schedule"
              className="hw-input"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 5 * * *"
            />
          </Field>
        )}

        {error !== null && (
          <p role="alert" className="hw-alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
