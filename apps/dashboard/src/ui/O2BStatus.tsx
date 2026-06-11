// Open Second Brain indicator: a compact "O2B" label plus a colour-coded dot —
// green (connected), red (not connected), amber (still probing / unknown). It
// doubles as a link whose target depends on whether O2B is installed:
//   - installed     -> the host's `/plugins` page (manage / configure it),
//   - not installed  -> the project repository (go get it),
//   - still checking -> rendered as a plain span (no destination yet).
// The dot tone tracks `connected`; the link target tracks `installed`. The full
// product name stays in the title/aria-label for assistive tech.

const REPO_URL = "https://github.com/itechmeat/open-second-brain";
// The host plugins page. Root-relative on purpose: this deployment serves the
// dashboard at the origin root. (A path-prefixed deploy — Hermes
// X-Forwarded-Prefix — would need this made prefix-aware, alongside the API
// base; tracked separately.)
const PLUGINS_URL = "/plugins";

export interface O2BStatusProps {
  /** true = connected, false = not connected, null = still checking. */
  connected: boolean | null;
  /** true = CLI installed, false = absent, null = still checking. */
  installed: boolean | null;
}

function toneFor(connected: boolean | null): "ok" | "down" | "unknown" {
  if (connected === null) return "unknown";
  return connected ? "ok" : "down";
}

function labelFor(connected: boolean | null): string {
  if (connected === null) return "Open Second Brain: checking…";
  return connected ? "Open Second Brain: connected" : "Open Second Brain: not connected";
}

export function O2BStatus({ connected, installed }: O2BStatusProps): React.ReactElement {
  const tone = toneFor(connected);
  const label = labelFor(connected);
  const dot = <span className={`hw-o2b-dot hw-o2b-dot--${tone}`} aria-hidden="true" />;

  // Still probing: no destination decided yet, so render a non-interactive span.
  if (installed === null) {
    return (
      <span className="hw-o2b" title={label} aria-label={label}>
        {dot}
        O2B
      </span>
    );
  }

  const href = installed ? PLUGINS_URL : REPO_URL;
  // The repo is an external destination; the host page is same-origin.
  const external = !installed;
  return (
    <a
      className="hw-o2b"
      href={href}
      title={label}
      aria-label={label}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      {dot}
      O2B
    </a>
  );
}
