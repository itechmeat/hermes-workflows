// OpenSecondBrain connection indicator: the "OpenSecondBrain" label plus a
// colour-coded dot — green (connected), red (not connected), amber (still
// probing / unknown). The textual state is replaced by the dot; the full state
// stays available to assistive tech via the title/aria-label.

export interface O2BStatusProps {
  /** true = connected, false = not connected, null = still checking. */
  connected: boolean | null;
}

function toneFor(connected: boolean | null): "ok" | "down" | "unknown" {
  if (connected === null) return "unknown";
  return connected ? "ok" : "down";
}

function labelFor(connected: boolean | null): string {
  if (connected === null) return "OpenSecondBrain: checking…";
  return connected ? "OpenSecondBrain: connected" : "OpenSecondBrain: not connected";
}

export function O2BStatus({ connected }: O2BStatusProps): React.ReactElement {
  const tone = toneFor(connected);
  const label = labelFor(connected);
  return (
    <span className="hw-o2b" title={label} aria-label={label}>
      <span className={`hw-o2b-dot hw-o2b-dot--${tone}`} aria-hidden="true" />
      OpenSecondBrain
    </span>
  );
}
