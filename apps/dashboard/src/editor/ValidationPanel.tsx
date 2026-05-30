import { useCallback, useState } from "react";
import { getApiClient } from "../host";
import type { WorkflowsApi } from "../api/client";
import type { ValidationResult } from "../api/types";

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
  const [busy, setBusy] = useState(false);

  const validate = useCallback(() => {
    setBusy(true);
    api
      .validateWorkflow(workflowId)
      .then((res) => {
        setResult(res);
        onResult?.(res);
      })
      .finally(() => setBusy(false));
  }, [api, workflowId, onResult]);

  return (
    <section style={{ padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>Validation</strong>
        <button type="button" onClick={validate} disabled={busy}>
          Validate
        </button>
      </div>
      {result !== null && (
        <div>
          {result.valid ? (
            <p role="status">Valid — no blocking errors.</p>
          ) : (
            <p role="alert">{result.errors.length} error(s) — fix before saving.</p>
          )}
          {result.errors.length > 0 && (
            <ul>
              {result.errors.map((issue, i) => (
                <li key={`e${i}`} style={{ color: "#e06c6c" }}>
                  <code>{issue.code}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul>
              {result.warnings.map((issue, i) => (
                <li key={`w${i}`} style={{ color: "#d6b25e" }}>
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
