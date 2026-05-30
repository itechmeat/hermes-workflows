# Brainstorm audit trail — xyflow editor (Epic 4)

Phase 0 of the feature-release-playbook for the visual editor + run inspector.

## Consultant

CLI consultants did not run this round: `claude -p` OOM-killed in the prior epic
and `codex exec` could not be launched through the shell (harness instability).
An in-process subagent produced the variants instead (equivalent independent
pass). Full output in `cli-output/consultant.md`; the three variants and the
consultant's recommendation are summarized there.

- **Variant 1** — Vite library build; `react`+`react/jsx-runtime` resolved via a
  shim over `window.__HERMES_PLUGIN_SDK__.React`; react-dom bundled (pinned to the
  host's 19.2.x); one IIFE/UMD bundle to `dashboard/dist`. Large / medium-risk.
- **Variant 2** — bundle a second React + react-dom as a self-contained island
  mounted into a host container. Large / high-risk (violates the single-React
  contract; bloat).
- **Variant 3** — drop `@xyflow/react`, hand-build an SVG/HTML canvas over host
  React only. Large / medium-risk (throws away the named library, most hand-work).

Consultant recommendation: **Variant 1**.

## Orchestrator decision: Variant 1 (Vite library build + host-React shim)

Agree with the consultant. Variant 1 is the only option that both honours the
host contract (one React instance — the host's 19.2.5) and keeps `@xyflow/react`,
which the task explicitly requires.

- **Variant 2 rejected**: a second React 19 in the page is exactly what the host
  contract warns against (broken hooks across the boundary, duplicated-React
  footguns, bloat). The host already provides React; shipping another is waste.
- **Variant 3 rejected**: reimplementing pan/zoom/connect/handles by hand is the
  largest, most error-prone path and discards a mature library and its
  interaction/accessibility polish for no contract benefit.

### Shape of the chosen approach

- A new `apps/dashboard` workspace (Vite + React 19 TSX + `@xyflow/react`),
  `build.lib` → a single self-executing bundle written to `dashboard/dist/index.js`
  (+ `dist/index.css`) that calls `window.__HERMES_PLUGINS__.register("workflows", App)`.
- `react` and `react/jsx-runtime` are aliased to tiny shim modules that re-export
  `window.__HERMES_PLUGIN_SDK__.React` (and implement `jsx/jsxs/Fragment` over
  `React.createElement`), so the bundle uses the host's single React instance and
  carries no second copy.
- API access goes through `SDK.fetchJSON` against the existing routes; client
  state is local (hooks/reducer), no global store needed at this size.
- TDD via Vitest + jsdom + React Testing Library, with the SDK globals and
  `fetchJSON` mocked in a setup file.

### Key risk to validate first (design spike, not yet resolved)

Whether `@xyflow/react` v12 actually imports from `react-dom` at runtime, and if
so which entry points (`createPortal`, `flushSync`). If it does, react-dom is
bundled and pinned to a 19.2.x compatible with the host React's internals; if it
does **not**, the react-dom concern disappears and only `react` is shimmed. This
is the first task in the plan — resolve it before building UI on top.
