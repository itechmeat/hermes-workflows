# Brainstorm consultant output — xyflow editor

Consultant: an in-process subagent (general-purpose) acting as the frontend
architecture consultant. The CLI consultants the playbook prefers could not run
this round: `claude -p` OOM-killed (exit 137) in the previous epic, and `codex
exec` could not be launched through the shell this session (harness instability).
The subagent is an equivalent independent pass; the orchestrator still decides.

Three variants below, verbatim.

---

### Variant 1: Vite library build, React externalized to host shim, react-dom bundled
- **Approach**: Add an `apps/dashboard` Vite project (`build.lib`, IIFE/UMD single
  file, no code-splitting, CSS to `dist/index.css`). `react` and
  `react/jsx-runtime` are resolved at runtime via a shim that re-exports
  `window.__HERMES_PLUGIN_SDK__.React`; `react-dom` is bundled (pinned to a 19.2.x
  matching the host) so it binds to the same externalized React. The bundle's
  top-level calls `__HERMES_PLUGINS__.register("workflows", App)`; `App` is an
  ordinary host-rendered component (no second root), so bundled react-dom only
  services @xyflow/react internals while the host owns the tree.
- **Trade-offs**: + single `dist/index.js`+`dist/index.css` matching the manifest;
  + one React instance (host's), hooks/context work; + first-class Vite/Vitest/
  jsdom/RTL test path; + real TSX authoring. − careful alias config, react-dom
  must match host React 19.2.5 or portals/flushSync break; − adds a build
  toolchain the project lacks, bundle grows past the 150KB kanban baseline;
  − committed `dist/` artifact + a jsx-runtime shim that is easy to get wrong.
- **Complexity**: large · **Risk**: medium

### Variant 2: Self-contained React island (bundle react + react-dom), mount into a host container
- **Approach**: Bundle its own React AND react-dom; on `register`, mount the editor
  via the bundled `createRoot(container).render(<App/>)` as an isolated island,
  talking to the backend only over `fetchJSON`.
- **Trade-offs**: + @xyflow gets a matched react+react-dom it controls (most robust
  for its internals); + standard Vite app build, no shim. − violates the host
  contract (a 2nd React 19 copy: bloat + duplicated-React footguns); − largest
  bundle; − manual root lifecycle (mount/unmount) risks leaks on tab swap.
- **Complexity**: large · **Risk**: high

### Variant 3: Custom SVG/HTML canvas over host React only (no @xyflow/react)
- **Approach**: Skip @xyflow/react; hand-build the canvas (SVG edges + positioned
  HTML nodes, pointer drag/connect, wheel zoom/pan) in the build-free IIFE style
  using only host React via `createElement`. No react-dom ever needed.
- **Trade-offs**: + zero new React/react-dom, zero toolchain, smallest bundle;
  + full control of status highlighting + dirty state; + testable today.
  − the task explicitly names @xyflow/react; reimplementing pan/zoom/connect/
  handles/minimap is large, error-prone, throws away a mature lib; − highest
  implementation/maintenance effort; − diverges from the deliverable.
- **Complexity**: large · **Risk**: medium

### Recommended: Variant 1
The host contract mandates reusing its single React 19.2.5 instance while
@xyflow/react hard-requires react-dom; externalizing `react` to a
`window.__HERMES_PLUGIN_SDK__.React` shim while bundling a version-pinned
react-dom is the only option that satisfies both without a second React
(Variant 2) or rebuilding the canvas (Variant 3). It delivers exactly the
required single `dist/index.js` (+`dist/index.css`) with a Vite/Vitest/jsdom test
path, keeping core zero-dependency since build devDeps live in `apps/dashboard`.
