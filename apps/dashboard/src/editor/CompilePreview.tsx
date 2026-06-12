import { useCallback, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { HermesPlan } from "../api/types";
import { Button } from "../ui/components";

export interface CompilePreviewProps {
  workflowId: string;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

// Shows the compiled Hermes plan (the native Kanban tasks / Cron jobs the
// workflow lowers to) for the saved spec, so the author sees what will run
// before triggering it.
export function CompilePreview({ workflowId, client }: CompilePreviewProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [plan, setPlan] = useState<HermesPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .compilePreview(workflowId)
      .then(setPlan)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Compile preview failed"))
      .finally(() => setBusy(false));
  }, [api, workflowId]);

  return (
    <section className="hw-section">
      <div className="hw-row hw-row--sm">
        <strong>Compile preview</strong>
        <Button onClick={preview} disabled={busy}>
          Preview plan
        </Button>
      </div>
      {error !== null && <p role="alert">{error}</p>}
      {plan !== null && (
        <div>
          <p>
            First node: <code>{plan.first_node ?? "—"}</code>
          </p>
          <p>
            {plan.kanban_tasks.length} Kanban task(s), {plan.script_steps.length} script step(s),{" "}
            {plan.cron_jobs.length} cron job(s)
          </p>
          {plan.profiles.length > 0 && <p>Profiles: {plan.profiles.join(", ")}</p>}
          {plan.skills.length > 0 && <p>Skills: {plan.skills.join(", ")}</p>}
          <ul>
            {plan.kanban_tasks.map((task) => (
              <li key={task.node}>
                <code>{task.node}</code> → {task.assignee || "(unassigned)"}
              </li>
            ))}
          </ul>
          {plan.script_steps.length > 0 && (
            <ul>
              {plan.script_steps.map((step) => (
                <li key={step.node}>
                  {/* Command preview before run (TZ §25.2). */}
                  <code>{step.node}</code>: <code>{step.command}</code>
                  {step.workdir !== undefined && <> in {step.workdir}</>}
                </li>
              ))}
            </ul>
          )}
          {plan.catalog !== undefined && (
            <div className="hw-catalog">
              {/* Template params rendered natively across surfaces from one
                  schema (mirrors the host blueprint catalog). */}
              <p>Template parameters: {plan.catalog.fields.map((f) => f.name).join(", ")}</p>
              <p>
                Slash command: <code>{plan.catalog.command}</code>
              </p>
              <p>
                Deep-link: <code>{plan.catalog.appUrl}</code>
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
