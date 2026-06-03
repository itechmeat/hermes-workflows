import type { NodeTelemetry } from "../api/types";

// Read-only telemetry block for the run inspector's node detail: the
// observer-derived aggregates the worker recorded (duration, tokens, API and
// tool calls, subagents, structured error). Rows render only when the
// underlying counter exists, so a sparse aggregate stays compact.

export interface TelemetryDetailProps {
  telemetry: NodeTelemetry;
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(t: NodeTelemetry): string {
  const total = t.total_tokens ?? 0;
  if (t.input_tokens !== undefined || t.output_tokens !== undefined) {
    return `${total} (${t.input_tokens ?? 0} in / ${t.output_tokens ?? 0} out)`;
  }
  return String(total);
}

function formatToolCalls(t: NodeTelemetry): string {
  const calls = String(t.tool_calls ?? 0);
  return t.tool_errors !== undefined && t.tool_errors > 0
    ? `${calls} (${t.tool_errors} failed)`
    : calls;
}

export function TelemetryDetail({ telemetry: t }: TelemetryDetailProps): React.ReactElement {
  const rows: [string, string][] = [];
  if (t.duration_ms !== undefined) rows.push(["Duration", formatDurationMs(t.duration_ms)]);
  if (t.total_tokens !== undefined) rows.push(["Tokens", formatTokens(t)]);
  if (t.api_calls !== undefined) rows.push(["API calls", String(t.api_calls)]);
  if (t.tool_calls !== undefined) rows.push(["Tool calls", formatToolCalls(t)]);
  if (t.subagents !== undefined) rows.push(["Subagents", String(t.subagents)]);

  return (
    <div className="hw-telemetry">
      <div className="hw-eyebrow">Agent telemetry</div>
      {rows.map(([label, value]) => (
        <div key={label} className="hw-telemetry-row">
          <span className="hw-telemetry-label">{label}</span>
          <span>{value}</span>
        </div>
      ))}
      {t.error_type !== undefined && (
        <p className="hw-error">
          {t.error_message !== undefined ? `${t.error_type}: ${t.error_message}` : t.error_type}
        </p>
      )}
    </div>
  );
}
