import { useState } from "react";
import type { LoggedRunEvent } from "./runLog";

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

// A floating, collapsible panel of the run's curated, timestamped history. Sits
// over the canvas (bottom-right) rather than in the page header, so it does not
// crowd the title bar. Empty until the first event is observed.
export function RunLogPanel({
  events,
}: {
  events: readonly LoggedRunEvent[];
}): React.ReactElement | null {
  const [open, setOpen] = useState(true);
  if (events.length === 0) return null;
  return (
    <aside className={`hw-runlog${open ? " is-open" : ""}`} aria-label="Run log">
      <button
        type="button"
        className="hw-runlog__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Run log ({events.length})
      </button>
      {open && (
        <ol className="hw-runlog__list">
          {events.map((e) => (
            <li key={e.key} className="hw-runlog__item">
              <time className="hw-runlog__time">{formatTime(e.at)}</time>
              <span className="hw-runlog__label">{e.label}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
