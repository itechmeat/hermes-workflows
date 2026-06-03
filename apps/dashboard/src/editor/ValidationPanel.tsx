import { useCallback, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { ValidationResult } from "../api/types";
import { Button } from "../ui/components";

export interface ValidationPanelProps {
  workflowId: string;
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
  onResult?: (result: ValidationResult) => void;
}

// Validation is server-authoritative: it checks the saved spec via the core CLI,
// so the editor never re-implements graph rules. Results render as blocking
// errors and non-blocking warnings.
export function ValidationPanel({ workflowId, client, onResult }: ValidationPanelProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const validate = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .validateWorkflow(workflowId)
      .then((res) => {
        setResult(res);
        onResult?.(res);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Validation request failed"))
      .finally(() => setBusy(false));
  }, [api, workflowId, onResult]);

  return (
    <section className="hw-section">
      <div className="hw-row hw-row--sm">
        <strong>Validation</strong>
        <Button onClick={validate} disabled={busy}>
          Validate
        </Button>
      </div>
      {error !== null && <p role="alert">{error}</p>}
      {result !== null && (
        <div>
          {result.valid ? (
            <p role="status">Valid — no blocking errors.</p>
          ) : (
            <p role="alert">{result.errors.length} error(s) — fix before saving.</p>
          )}
          {result.errors.length > 0 && (
            <ul className="hw-issues">
              {result.errors.map((issue, i) => (
                <li key={`e${i}`} className="hw-issue--error">
                  <code>{issue.code}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul className="hw-issues">
              {result.warnings.map((issue, i) => (
                <li key={`w${i}`} className="hw-issue--warn">
                  <code>{issue.code}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
