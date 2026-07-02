import { useState } from "react";

import { Button } from "./Button";

// Shown when a dashboard page cannot reach the Workflows backend. The backend
// is a standalone sidecar: recent Hermes does not auto-mount a non-bundled
// plugin's Python routes (GHSA-5qr3-c538-wm9j), so the operator must run the
// sidecar as a persistent service AND route `/api/plugins/hermes-workflows/*` to it.
// The panel offers two fixes: a ready-to-paste agent prompt that does it all,
// and a human step-by-step. Both set it up ONCE, persistently, and against the
// stable plugin path so a `hermes plugins update` never breaks it.

export interface BackendUnavailableProps {
  /** What failed to load, e.g. "workflows" or "runs"; named in the body. */
  resource: string;
  /** Underlying error message, surfaced for diagnostics when present. */
  detail?: string;
}

const DOCS_URL =
  "https://github.com/itechmeat/hermes-workflows/blob/main/docs/dashboard.md#running-the-backend-standalone-sidecar";

// Self-contained, OS-agnostic, idempotent. The agent resolves the stable plugin
// path itself and builds a persistent service from it, so reboots and plugin
// updates do not break the setup.
const AGENT_PROMPT = `Set up the Hermes Workflows dashboard backend so its tab works permanently. Context: the plugin's API is a separate sidecar that Hermes does NOT auto-mount for a non-bundled plugin (security advisory GHSA-5qr3-c538-wm9j), so it must run as a persistent service and the dashboard must reverse-proxy the path /api/plugins/hermes-workflows/* to it. Make every step idempotent so re-running changes nothing, and so it survives reboots and \`hermes plugins update\`.

1. Resolve the installed plugin directory (the stable path, e.g. ~/.hermes/plugins/hermes-workflows). Always reference THIS path, never a version-specific one, so plugin updates do not break the service.
2. Install a persistent user service that runs <plugin-dir>/bin/hermes-workflows-dashboard-api, enabled at login with restart-on-failure: a systemd --user service on Linux, or a launchd LaunchAgent on macOS. The sidecar binds 127.0.0.1:9123 by default; honour a custom host/port if one is set via the plugins.workflows.dashboard_api_host / dashboard_api_port config keys or the HERMES_WORKFLOWS_DASHBOARD_API_HOST / HERMES_WORKFLOWS_DASHBOARD_API_PORT env vars, and use that same address in step 3.
3. Make the dashboard reach it on the same origin: in the reverse proxy that fronts the Hermes dashboard, route /api/plugins/hermes-workflows/* to the sidecar's address (default 127.0.0.1:9123, or the custom one from step 2) BEFORE the catch-all that serves the dashboard. If the Hermes dashboard is opened directly with no proxy in front, install a small local reverse proxy (Caddy) that serves the dashboard and this prefix on one origin, as a persistent service too.
4. Verify: the sidecar's GET /healthz returns ok and reloading the Workflows tab lists workflows. Full systemd / launchd / Caddy / nginx snippets are in <plugin-dir>/docs/dashboard.md. Report what you did and the final health check.`;

export function BackendUnavailable({
  resource,
  detail,
}: BackendUnavailableProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copyPrompt = (): void => {
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    };
    const clip = navigator.clipboard;
    // writeText returns a promise per spec, but some embedded webviews throw
    // synchronously when the clipboard is blocked by a permissions policy.
    // Guard both so the button still gives feedback either way.
    try {
      if (clip !== undefined) {
        void clip.writeText(AGENT_PROMPT).then(done, done);
      } else {
        done();
      }
    } catch {
      done();
    }
  };

  return (
    <div className="hw-page hw-backend-unavailable">
      <h2>Could not load {resource}</h2>
      <p>
        The Workflows tab loaded, but the request for {resource} failed. On a fresh install the
        usual cause is that the plugin backend is not reachable yet: it runs as a separate sidecar
        that recent Hermes does not auto-mount (GHSA-5qr3-c538-wm9j), so it has to run as a service
        and be routed by the dashboard host. Set that up once with either option below - it
        persists across reboots and plugin updates. If it is already in place, the backend may be
        up but returning an error - check the detail at the bottom of this page.
      </p>

      <h3>Option 1 - let your agent do it</h3>
      <p>Copy this and paste it to your AI agent (Claude Code, Codex, …); it will set everything up:</p>
      <pre className="hw-agent-prompt">{AGENT_PROMPT}</pre>
      <Button onClick={copyPrompt}>{copied ? "Copied" : "Copy agent prompt"}</Button>

      <h3>Option 2 - do it by hand</h3>
      <ol>
        <li>
          Find the installed plugin directory (the stable path, e.g.{" "}
          <code>~/.hermes/plugins/hermes-workflows</code>). Use this path everywhere so a{" "}
          <code>hermes plugins update</code> never breaks the setup.
        </li>
        <li>
          Install a persistent service that runs{" "}
          <code>&lt;plugin-dir&gt;/bin/hermes-workflows-dashboard-api</code> at login with
          restart-on-failure: a <code>systemd --user</code> service on Linux, or a launchd
          LaunchAgent on macOS. It binds <code>127.0.0.1:9123</code> by default; for a custom
          address set <code>plugins.workflows.dashboard_api_port</code> (and{" "}
          <code>…_host</code>) in config, or the{" "}
          <code>HERMES_WORKFLOWS_DASHBOARD_API_PORT</code> / <code>…_HOST</code> env vars.
        </li>
        <li>
          In the reverse proxy in front of the Hermes dashboard, route{" "}
          <code>/api/plugins/hermes-workflows/*</code> to the sidecar's address (default{" "}
          <code>127.0.0.1:9123</code>, or your custom one) ahead of the catch-all that serves the
          dashboard, so the tab's same-origin calls reach it. With no proxy in front, stand up a
          small local one (Caddy) serving both on one origin.
        </li>
        <li>
          Verify <code>GET /healthz</code> on the sidecar returns ok, then reload this tab.
        </li>
      </ol>
      <p>
        Full systemd, launchd, Caddy, and nginx snippets:{" "}
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          docs/dashboard.md
        </a>
        .
      </p>

      {detail !== undefined && detail !== "" ? (
        <p className="hw-muted">
          Backend error: <code>{detail}</code>
        </p>
      ) : null}
    </div>
  );
}
