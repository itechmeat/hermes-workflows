# Changelog

All notable changes to Hermes Workflows are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.8 - 2026-07-02

Restores the Workflows tab in the Hermes dashboard. It disappeared after a
Hermes update tightened how a non-bundled plugin's dashboard backend and static
assets are gated on `plugins.enabled`.

- The dashboard plugin now identifies as `hermes-workflows` instead of
  `workflows`, matching the package directory and the `plugins.enabled` entry.
  Hermes gates the plugin API mount and asset serving on the dashboard manifest
  name; when that name did not match the enabled-list entry, both were silently
  skipped and the tab vanished. The frontend API base moves to
  `/api/plugins/hermes-workflows/` to match the new mount prefix.

## 0.7.7 - 2026-07-01

Completes the transient-error node retry from 0.7.6 on the Kanban
(project-scope) path, where every real release run executes. A momentary
provider 429 on a single `agent_task` node no longer aborts the whole run.

- Kanban `agent_task` nodes now retry an engine-level transient failure with
  exponential backoff instead of aborting. The agent CLI exits cleanly even when
  its own HTTP retries exhaust on a 429 / overloaded / 5xx blip, so the native
  dispatcher records the card done and its `max_retries` never fires; the engine
  now re-classifies that completion and, on a transient verdict, re-schedules a
  fresh card (up to the node's `max_retries`) before settling failure.
  Deterministic failures still fail fast, and a single blip with
  `max_retries >= 1` no longer routes a run straight to abort.
- The transient classifier's verdict is carried through the Kanban completion to
  the engine (it was computed and then discarded), and `usage limit` joins the
  transient provider-error sentinels.
- Node retry state (`transient_retries`, `retry_after`) persists across advance
  ticks via two forward-migrated `workflow_node_runs` columns, so the attempt
  count and backoff window survive the per-tick run reload.

## 0.7.6 - 2026-06-25

A sweep of known reliability bugs in the run engine and its cron tick, fixed
together so a transient provider blip or a torn-down worktree can no longer
silently corrupt or stall a release run.

- The Python test suite no longer writes into the operator's real cron store.
  The cron-bridge paths (`CRON_DIR` / `JOBS_FILE` / `OUTPUT_DIR`) are sandboxed
  through a shared autouse fixture, so running the suite on a live host can no
  longer leak a job that shadows and breaks the production advance-all tick.
- Direct-node outcomes are classified from the agent's actual result rather than
  the process exit code alone. A graceful agent failure - a transient provider
  error (HTTP 429 / overloaded / 5xx / exhausted retries) surfaced on a clean
  exit, or an explicit `node_outcome: failure` the agent reports - now settles
  the node as failed instead of being recorded as success.
- Transient provider errors get a bounded node-level retry with backoff, so a
  momentary 429 or overload no longer fails an entire long-running release run;
  deterministic failures still fail fast.
- A repo-local workflow spec now overrides a global spec sharing the same id,
  instead of the global copy silently shadowing it; the repo-local discovery
  directory takes precedence in spec resolution.
- The advance-all cron tick is never armed with a transient git-worktree path.
  `command_path()` rewrites a `.worktrees/<id>` entrypoint back to the stable
  parent-repo path, so the tick survives worktree cleanup instead of dying with
  exit 127 and silently stalling every run's advancement.

## 0.7.5 - 2026-06-24

A self-review pass over the recent patches:

- `resume` now resolves specs through the CLI spec roots (including the
  repo-local `<cwd>/.hermes/workflows`), so a run started from a project-local
  spec can be resumed like every other command, instead of only the global
  roots.
- The unreachable-backend dashboard panel no longer asserts a single cause: it
  frames the sidecar setup as the likely cause and points to the error detail
  for the case where the backend is up but returning an error, and its clipboard
  copy is guarded against webviews that throw synchronously.
- README gains an FAQ (platform, vault, dashboard access, agent/profile
  naming); the dashboard docs note the launchd `KeepAlive` restart loop when the
  sidecar port is already taken.

## 0.7.4 - 2026-06-24

When the Workflows dashboard backend is unreachable, the tab now shows an
actionable setup panel instead of a bare "Failed to load" line. It offers a
copy-paste agent prompt that installs the sidecar as a persistent service and
routes `/api/plugins/workflows/*` to it - idempotent, and pinned to the stable
plugin path so it survives reboots and `hermes plugins update` - plus a human
step-by-step. The dashboard docs gain a macOS launchd LaunchAgent snippet and a
custom host/port note.

## 0.7.3 - 2026-06-24

The dashboard header now shows the installed plugin version. The version segment
before the `-bN` build counter is resolved from the root plugin manifest in both
the build and the test config, instead of the dashboard sub-app's own
`package.json`, so it always matches the plugin release.

## 0.7.2 - 2026-06-23

`hermes-workflows run <id>` now also discovers specs in `<cwd>/.hermes/workflows`,
and the spec path a run was created from is persisted (`workflow_path`) so `status`
and `advance-all` keep working from any directory. A stored path that no longer
exists falls back to resolving the workflow by id.

## 0.7.1 - 2026-06-23

Restores the Workflows dashboard tab on a hardened Hermes. Recent Hermes refuses
to auto-import the Python backend of a non-bundled plugin
(GHSA-5qr3-c538-wm9j / #43719), so this plugin's `plugin_api.py` was no longer
mounted (`has_api: false`) and the tab loaded but could not fetch data. The
model-facing tools and the operator CLI were unaffected.

### Added

- **Standalone dashboard-API sidecar.** `hermes_workflows.dashboard_api` (run via
  `bin/hermes-workflows-dashboard-api` or `python -m hermes_workflows.dashboard_api`)
  serves the dashboard backend out-of-process. It mounts the **existing**
  `dashboard/plugin_api.py` router verbatim — no routes are re-declared — under
  `/api/plugins/workflows`, plus a `GET /healthz` liveness route. The frontend is
  unchanged: the operator's reverse proxy routes `/api/plugins/workflows/*` to the
  sidecar in front of the dashboard. Bind host/port are configurable via
  `plugins.workflows.dashboard_api_host` / `…_port` (config ▸ env ▸ default
  `127.0.0.1:9123`); the sidecar binds loopback only and inherits the dashboard's
  trust model (loopback + proxy-level auth), shipping no auth of its own.
- Docs (`docs/dashboard.md`): why the sidecar exists and ready-to-paste systemd,
  Caddy, and nginx wiring. A bundled install needs none of it.

## 0.7.0 - 2026-06-23

Release automation is now ready for bundled, operator-driven workflow releases:
adopted cards stack on one shared feature branch, failed runs can be resumed from
the current live spec, and workflow specs can be exported as portable template
bundles.

### Added

- **Run resume.** Added `resume <run_id> [--node <id>] [--all]` for operators and
  dashboard resume/restart actions for terminal failed or cancelled runs. Resume
  preserves single-flight guarantees, advances after retry, and refuses
  structural spec drift while allowing same-graph live spec edits.
- **Template export.** Added `export --as-template <id>` plus dashboard template
  download, emitting a placeholder `.template.yaml` and AI-authored
  `.template.md` adaptation guide. Template generation is cached by
  `(workflow_id, spec_sha, template_format, generator_version, resolved_model)` and keeps v1 export-only.
- **`spec_sha`.** Added a stable serialized-spec hash primitive so template
  exports invalidate on any material spec change even when the workflow version
  is unchanged.

### Changed

- **Stacked adopted-card dispatch.** Adopt-driven release scopes now run cards on
  the shared `feat/<slug>` tip with a commit barrier before the next card starts,
  preserving cross-card context and leaving docs/version updates to one final
  release step.
- **Dispatcher worktree conformance.** Driven cards now align with Hermes linked
  worktrees and worker `TERMINAL_CWD`, with conformance checks that prevent
  accidental anchoring in the gateway checkout instead of the project repo.

## 0.6.0 - 2026-06-22

Workflow runs now advance the moment a node finishes instead of waiting out the
~2-minute poll. A multi-node run that used to take ~10-12 min wall-clock —
dominated by per-transition tick latency — advances node-to-node in seconds.

### Added

- **Event-driven advance.** A worker that completes or blocks a workflow card
  fires the native Kanban lifecycle hooks (`kanban_task_completed` /
  `kanban_task_blocked`, Hermes #50349); the plugin observes them and spawns a
  detached, scoped `hermes-workflows advance-run <run_id>` — the same idempotent
  advance cycle, scoped to the owning run — so the run progresses immediately
  rather than on the next poll. A per-run debounce
  (`plugins.workflows.event_debounce_seconds`, default 2s) coalesces a burst of
  parallel-node completions into one spawn. The observers are best-effort and
  never break the worker's completion path.

### Changed

- **Configurable advance-tick cadence.** The residual `advance-all` tick is no
  longer pinned to the hardcoded `every 2m`: its schedule is the new
  `plugins.workflows.tick_schedule` setting (config ▸ env ▸ default `every 2m`),
  tunable from the Settings page without a code edit. With event-driven advance
  handling card transitions, the tick is now the coarse safety-net + `wait`-node
  poll, not the latency driver; Hermes cron is minute-granular, so a sub-minute
  value is bounded by the scheduler — sub-minute latency comes from the event
  path. The active/idle lifecycle is unchanged: the tick is torn down at zero
  active runs (no busy-polling).

## 0.5.1 - 2026-06-20

A patch release with two follow-up fixes to the v0.5.0 `adopt` blocked-card
time-box. Both remove a case where an `adopt` node waited out the full 6h
backstop instead of settling promptly.

### Fixed

- **Dependency-ordered adopt.** When a driven scope contains internal dependency
  links, the engine now drives the cards in dependency order (prerequisites
  first) instead of all at once, so a dependent is never claimed before its
  prerequisites are done. A worker would otherwise self-`kanban block` the
  dependent, and a worker block does not auto-clear, which previously left the
  run waiting out the time-box. Reuses the existing sequential `adopt_seq`
  machinery. A scope with no internal links keeps the existing parallel
  behavior.
- **Skip un-completable umbrella cards.** An umbrella/epic card (title prefixed
  `(meta)` or `(epic)`) with incomplete children has no leaf work of its own.
  The engine now excludes such cards from the driven set and drives their
  executable children instead; a scope that is only umbrella cards fails the
  node fast with guidance, rather than promoting an un-completable card and
  waiting out the backstop.

## 0.5.0 - 2026-06-20

Parameterized workflows can now be instantiated with real values from every
in-repo surface, and a long-standing `adopt` hang on a blocked driven card is
closed. A template declares typed `params`, node prompts interpolate
`{{params.X}}`, and the core validates and substitutes the values at run start.

### Added

- **Template-parameter instantiation.** A run carries resolved `params`
  (persisted in a new `params_json` column). `run-create --params <json>`
  validates supplied values against the workflow's declared params with
  `fillParams` - an unknown name, a missing required value, or a bad
  enum/int/bool fails loud, and declared defaults are applied. The engine
  substitutes each `{{params.<name>}}` placeholder over the fully composed node
  prompt at schedule time, failing loud on a placeholder with no run value (the
  same contract as `input_mapping`). Three surfaces fill the same schema: the
  dashboard Run form (one native field per param), the
  `/workflow run <id> [project] name=value …` chat command (quotes preserved),
  and the run API `POST /workflows/{id}/run` with a `params` object.
- **`unknown_param_ref` validation.** A `{{params.X}}` reference to a param the
  workflow does not declare is rejected at author time, in both `agent_task` and
  `prompt` nodes.

### Fixed

- **`adopt` no longer hangs on a blocked driven card.** A driven Kanban card a
  worker `kanban block`s (consecutive failures stay 0, so the dispatch-stuck
  guard never trips) used to be polled forever, wedging the run in `running`
  indefinitely. The blocked branch is now time-boxed
  (`adopt_blocked_timeout_seconds`, default 6h) and settles the node failure
  loudly; the clock is persisted across ticks and resets when the card recovers.

### Changed

- **Hermes compatibility note.** Node output is captured from the worker
  session's final result, which must survive a mid-run context auto-compression
  (session rotation). The README now documents that this requires a Hermes build
  with the compression fixes (#48584, #48633); cards are created via `kanban_db`,
  not the `kanban_create` tool, so #48635 auto-subscribe-on-create does not apply
  to workflow cards.

## 0.4.0 - 2026-06-18

A Prompt node that packages the operator-input mechanism as an authorable graph
node, plus a set of editor legibility fixes: panning no longer marks the graph
dirty, the header drops its status text and inline errors in favour of toasts, a
node opens read-only on a double-click during a run, and the run-log panel shows
during editor playback.

### Added

- **Prompt node.** A new `prompt` node type: an optional block of authored text
  with one input and one output, nothing else. Its text becomes the operator
  directive for every `agent_task` reachable downstream of it (a transitive walk
  over the edges), so a Prompt node governs the whole sub-flow from its insertion
  point. The directive holds the highest authority over each step's decisions but
  is carried out only through that step's own role - a read-only step stays
  read-only, so a run-wide directive cannot make a step overstep and
  short-circuit the graph. The same layering the run `--input` applies, packaged
  as an authorable graph node. Routing-only: it creates no Kanban card and runs
  no worker. When an agent task's own prompt is empty the Prompt node text
  becomes the whole instruction; the run `--input`, when set, still sits above it.
- **Operator-input field on the editor Run affordance.** The editor can now
  supply a run-wide operator directive: a Run-input button next to Play opens a
  modal with an optional textarea whose text is layered above every `agent_task`
  prompt at highest priority for that run (the same directive the
  `/workflow run --input` CLI supplies). The plain Play button keeps its
  no-input start.
- **Off-board agent_task nodes.** A project-scope `agent_task` can set
  `board: false` to run off the project board through the direct profile runner:
  no Kanban card is created, so internal orchestration steps no longer clutter
  the operator's board - real cards stay reserved for the actual work (an
  `adopt` node, or an epic card the run opens). Off-board nodes run without a
  project worktree, so they are for reasoning/orchestration steps; a no-op in
  `global` scope.

### Fixed

- **Prompt-node text reaches the first dispatched card.** A regression guard
  asserts a Prompt node wired as the entry layers its authored text into the
  first scheduled card body at run start (the node resolves instantly and its
  successor schedules in the same advance).
- **Panning the canvas no longer marks the workflow dirty.** A pure pan or zoom
  no longer flips the editor to "unsaved"; the viewport still rides along on the
  next genuine save.
- **Editor status text removed from the header.** The save-status label
  ("Unsaved changes" / "Saved" / "No changes") is gone - the Save button is
  enabled exactly when there are unsaved changes, which is the signal.
- **Editor errors surface as toasts.** Run start, poll, and attach failures show
  as a dismissible toast instead of inline header text, and self-heal: a
  transient poll error clears on the next good poll.
- **Double-clicking a node during a run opens it read-only.** Previously the
  double-click only zoomed the canvas; it now opens the node inspector fully
  disabled, so a live run can be inspected but not edited.
- **Run-log panel during editor playback.** The curated, timestamped run log now
  shows while a run plays from the editor, not only on the Runs inspector.

## 0.3.0 - 2026-06-16

Operator control and run resilience: a free-form run input that overrides node
prompts at the highest priority, an opt-in sequential mode for driving shared-
branch cards one at a time, a bounded wait that fails a stuck adopt node instead
of polling forever, and the plugin version shown in the dashboard header.

### Added

- **Run-level operator input.** `hermes-workflows run <id> --input "<prompt>"`
  (and `/workflow run <id> --input ...`) layers a free-form instruction above
  every `agent_task` node's prompt at the highest priority: it overrides
  conflicting node instructions and otherwise binds as an additional constraint.
  Persisted on the run, applied to every node across ticks, shown read-only in
  the run inspector.
- **Sequential adopt mode.** An `adopt` node with `sequential: true` drives its
  referenced cards one at a time (promote, run to terminal including review,
  then the next), so workers build on prior committed work on a shared branch.
  Default stays concurrent.
- **Plugin version and build number in the header.** The dashboard top bar shows
  the current plugin version plus a monotonic build counter as `vX.Y.Z-bN` (e.g.
  `v0.3.0-b1`); the counter lives in `apps/dashboard/build-number.json`, is bumped
  per committed dashboard build, and resets to 0 on release.
- **Conditional branching in the editor.** Each non-terminal node exposes labeled
  source handles per outcome (success/failure, approved/rejected/needs_changes,
  plus "else" and a plain "always"); the handle an edge leaves from encodes its
  condition, so a branch is authorable by dragging and visible at a glance. A
  custom edge type colors and labels a conditioned edge, an edge inspector sets or
  clears the branch (including branching on another node's status), and the
  `condition` node finally has a usable inspector.
- **Per-node completion-notification toggle.** An `agent_task` node can opt its
  card's "done" ping in or out (`notify_completion`) independently of the
  workflow-level `subscribe_cards` default; surfaced as a tri-state control in the
  node inspector.
- **`/workflow` natural-language entry.** Free text after `/workflow` that is not
  an explicit subcommand resolves to a workflow id and the operator instruction
  (the run input), or asks a short clarifying question when the target is
  ambiguous or unknown.
- **Floating run-log panel.** The running-workflow page shows a collapsible,
  timestamped, curated history of the run (started with the operator input, nodes
  completed/failed, gates entered and resolved, terminal outcome) over the canvas,
  filtered to user-facing events only.
- **Save-failure toast.** A workflow that fails server-side validation on save now
  raises a prominent, dismissible toast naming the offending node(s) and the
  human-readable reason (e.g. "a node branches on node_status but covers neither
  outcome"), instead of only a small inline status label built from bare error
  codes. Validation stays server-authoritative.
- **Edge hover highlight.** Hovering a connection in the editor turns it blue and
  lifts it above the nodes, so a single edge is followable end to end in a dense
  graph; mouse-out restores its branch color and stacking.

### Changed

- An `adopt` node now bounds its wait: a driven card the dispatcher cannot make
  progress on (a climbing consecutive-failure count while it sits un-run, including
  an unspawnable reviewer profile) settles the node failure with a clear reason and
  an operator notice, instead of polling it forever.
- A chat reply to a uniquely-waiting gate now accepts a bare pick (a number,
  "scope 3", or a scope name) as approval with the reply text as the note, not only
  the literal `approved`/`rejected`/`needs_changes` tokens. The operator input is
  no longer shown as a page-header string; it appears as the first run-log entry.
- Waiting for a PR merge is handled by the worker-free `wait` node
  (`wait_for: { github_pr_merged: ... }`), polled in the engine tick with no Kanban
  card. A release PR left open for hours therefore never accrues dispatcher
  failures or auto-blocks while it waits, and the run proceeds on merge with no
  manual unblock - the stall seen when a merge-wait was modeled as an `agent_task`
  that reported failure to "keep waiting". Now regression-guarded.

### Fixed

- `bin/hermes-workflows` no longer claims a `~/.hermes/bin` symlink that is not
  created; the header and docs describe the actual resolution (optional installed
  symlink, falling back to the in-repo wrapper).
- An `adopt` node drives board cards from a typed `task_ids` channel captured from a
  structured ```` ```task_ids ```` block (or `<task_ids>` tag) in the resolving node's
  worker output - the chosen ids, isolated from any stray `t_`-shaped token in its
  prose - rather than shape-scraping free text or input values (which grabbed wrong
  ids and could not isolate the chosen scope). A bare shape-scrape remains only a
  last-resort fallback. An adopt that resolves zero ids now fails the run closed
  instead of falling through to a downstream build/PR with an empty branch.
- A global (`direct`) `agent_task` node no longer hangs `started`-but-unsettled
  when the short-lived advancing process (a CLI `run` or the cron `advance-all`
  tick) exits. The agent ran in a daemon thread of that process and died with it,
  orphaning the worker and stranding the node; it now runs in a detached process
  that outlives the scheduler and writes its own settled completion. Cron-triggered
  global workflows are covered. The detached worker also settles a failure when its
  own spec file is missing or corrupt, so a bad launch can never strand the node.
- A hard run abort (an adopt that drove zero cards, or a sequential adopt that
  cannot promote its next card) now closes the run failed even when another node
  is still active or waiting in a parallel branch, instead of being masked by the
  active node. A sequential adopt whose next-card promotion errors fails closed
  rather than wedging the tick.
- A chat gate reply that is a capitalized decision token (e.g. `Rejected fix the
  lint`) is now matched case-insensitively as that decision, instead of slipping
  past the token check and being auto-approved as a bare pick.
- The CLI preserves a free-form `--input` value that itself begins with `--`,
  rather than mistaking it for the next flag and dropping the operator prompt.
- `read_completion` feature-detects the board's `consecutive_failures` column, so
  polling still works against an older Kanban schema that lacks it.

## 0.2.0 - 2026-06-15

A visual overhaul of the dashboard plugin on a shared component kit, richer
`agent_task` editing backed by live host data, run observability built on
the Hermes observer-hook contract — per-node agent telemetry, pending
command-approval surfacing, an opt-in per-run JSONL trace — and editor
playback: run the workflow you are editing and watch it play on the canvas.
This release also makes a run Kanban-native (drive existing board cards, with an
optional native review stage), gives gates a two-way chat channel and an operator
note, adds a worker-free `wait` node, a `/workflow` chat command and a
`hermes-workflows cancel` CLI, surfaces blocked cards and live status, and keeps
hand-authored specs readable.

### Added

- Base UI component primitives: the dashboard's form controls (input, textarea,
  select, checkbox, button) are now backed by accessible `@base-ui/react`
  primitives behind a thin `ui/components/` wrapper layer, dressed in the
  existing Hermes styling. The select is a portaled, keyboard-driven listbox
  (with provider-grouped options for the model picker) rather than a native
  `<select>`. A new `DESIGN.md` documents the wrapper-plus-Hermes-styling
  contract so other plugins can adopt the same pattern.
- Inter-node data flow: an `agent_task` can consume a prior node's output by
  declaring `input_mapping: { <placeholder>: "{{nodes.<id>.output}}" }` and
  referencing `{{<placeholder>}}` in its prompt. The engine substitutes each
  placeholder with the referenced node's captured output at schedule time (one
  pass, for both the global and project backends), so a workflow passes data
  through the run state instead of a host file and stays fully exportable. The
  reference is validated when the workflow is authored — the source must be a
  prior (ancestor) node, and every declared placeholder must appear in the
  prompt — and an output that never materialised fails the node loudly rather
  than substituting empty text.
- Editor Play button: run the workflow straight from the editor page. A dirty
  graph is saved first (a failed save aborts the start); while the run plays,
  the editor canvas switches to the read-only run pipeline and shows live
  per-node status (running / completed / failed) at the editor's node
  positions with editing locked; when the run reaches a terminal status — or
  parks in `waiting` for a human review, which only the inspector can answer —
  the dashboard redirects to the run inspector. A rejected start or a failed
  poll is shown as a visible alert; a poll error clears on the next successful
  poll instead of killing playback. Both run surfaces now share one polling
  hook and one canvas node-type registry, and the run inspector reports poll
  and cancel/retry failures inline instead of swallowing them.
- Non-blocking run start: `POST /workflows/{id}/run` records the run, arms the
  advance tick, and drives the run from a background loop (advance every 2 s
  until it settles or parks for review), returning the created state
  immediately. Previously the route executed the first advance synchronously —
  for a global-scope `agent_task` that held the request open for the whole
  first node. The CLI `run` command and the dashboard route now both ensure
  the singleton tick cron while the run is active, so a multi-node run keeps
  advancing even with no schedule and no dashboard process alive.
- Truthful `running` status for global nodes: the Direct executor starts the
  profile runner in a background thread, marks the handle started, and the
  engine flips the node from `scheduled` to `running` while the agent works
  (the started marker also prevents a concurrent tick from double-starting
  the node). Running renders fixed blue and completed fixed green on the
  canvas — the theme's ring token rendered near-white, reading as no status.
- Per-node agent telemetry: observer hooks registered inside kanban worker
  processes aggregate API attempts, token usage, tool calls, subagents, and
  structured errors into a per-card sidecar; the engine folds it into
  `NodeRunState.telemetry` (new `telemetry_json` column, migrated in place)
  when the node settles, and `GET /runs/{id}` overlays the sidecar live while
  the node is still running. The run inspector's node detail renders the
  telemetry block; the Runs page gains a Tokens column from the per-run total.
- Pending command-approval surfacing: while a node's worker is blocked on a
  dangerous-command approval, the node card shows a waiting badge and the node
  detail names the command; a deny or timeout stays visible after the node
  settles so a subsequent failure has context. Observer-only — no change to
  the approval flow itself.
- Opt-in per-run JSONL trace (`observability.trace_enabled`, default off): the
  engine appends one self-describing line per event — run created, node
  scheduled/settled with outcome and seq, status transitions, review
  decisions, lifecycle markers — to `traces/<run_id>.jsonl`, and the Runs
  page export downloads the timeline as a second file when present. Disabled
  means zero trace I/O on the tick path; a write failure never affects a run.
- Plugin header with section navigation (Workflows / Runs / Schedules / Settings),
  an OpenSecondBrain connection indicator, and a portal slot the active view fills
  with its own title and actions.
- Hash-based routing: every view (including an open editor or run inspector) maps
  to a URL hash, so deep links, refresh, and browser back/forward work.
- Shared UI kit under `src/ui/components` (`Button`, `Badge`, `Field`, `Menu`,
  `Modal`, `PageHeader`) and an inline SVG icon set, with component tests.
- `GET /profiles` plugin route serving agent-profile names from the Hermes
  roster, and a model list read from the host model picker
  (`/api/model/options`); the node inspector offers both as select fields while
  preserving values not in the current roster/model list.
- Native Hermes alignment after Automation Blueprints (the multi-node layer
  above the single-prompt blueprint tier):
  - First-class delivery: a workflow may declare a `deliver` target in Hermes
    `DeliveryTarget` syntax (or the literal `origin`). When set, a completed run
    delivers its result to that target through the native delivery router rather
    than the terse lifecycle line; a result containing `[SILENT]` suppresses
    delivery. Lifecycle behaviour is unchanged when `deliver` is unset.
  - Skills are chosen in the node inspector from the host `/api/skills` catalog
    via a multi-select (built from the Base UI checkbox), replacing the
    free-text field; a current skill absent from the catalog is preserved.
  - Typed template parameters: a workflow used as a template can declare
    `params` (typed slots, mirroring the host blueprint slots) as the single
    source of truth, and the compile preview surfaces a `catalog` — the form
    fields plus a ready-to-paste `/workflow` command and a `hermes://` deep-link
    — emitted from that one schema (`packages/core/src/templates/params.ts`).
  - Event triggers: the workflow trigger gains `webhook` / `github` / `api`
    variants with an `events` filter and an `{event.*}` mapping namespace,
    declarable, validated, and shown in the compile preview. (Firing waits on an
    upstream Hermes change — the host dispatches events only to agent prompts /
    direct delivery; no local stub is added.)
  - The Schedules page tags each row as a `Workflow` schedule, distinct from
    blueprint cron jobs, and README positions the two tiers.
- Drive existing Kanban cards: an `agent_task` with `adopt: true` + `task_ref`
  drives one or more EXISTING board cards (assign the node profile, promote into
  the dispatch lane, poll to terminal) instead of creating a new card — the
  native flow where the work is the card. `task_ref` is a literal id or a typed
  `{{nodes.<id>.output.task_ids}}` reference that extracts the ids an upstream
  node surfaced; the node gates on all driven cards, idempotent on a card already
  running, and fails loud on a missing card. An optional `review_profile` routes
  each completed driven card once through Hermes' native `review` stage.
- `human_review` resolution carries an optional operator note (`review` CLI
  `--note`, the `workflow_review` tool, the dashboard), landing on the gate as
  `review_note` and consumable downstream as `{{nodes.<gate>.review_note}}` — a
  channel distinct from a work node's `.output`.
- `hermes-workflows cancel <run_id>`: cancel a run and its active nodes from the
  shell (wraps the core `run-cancel`; idempotent on terminal runs).
- A native `/workflow` in-chat slash command (registered via
  `ctx.register_command`, so it works in the CLI and gateway/messenger sessions,
  with an args hint for native pickers): `list`, `run <id> [project]`,
  `status <run>`, `review <run> <node> <decision> [note]`, `cancel <run>`,
  `explain <id>` — a thin front-end over the same tools the model uses.
- Node-type icons on canvas nodes, from a shared icon map also used by the
  header's add-node menu, so the picker and placed nodes match.
- The node inspector opens during a run in a fully read-only (disabled) state, so
  a node's configuration can be inspected mid-run without risking an edit.
- `notifications.subscribe_cards: false` (default true): a spec-level opt-out for
  the per-card Kanban completion subscriptions, silencing the native `✔ Kanban …
  done` ping per node on a long autonomous workflow while keeping run-level
  lifecycle notices and explicit `hermes send` messages.
- A worker-free `wait` node: it parks active and the engine tick polls its
  `wait_for` predicate (no Kanban card, no LLM worker), settling success/failure
  and branching on `node_status`. The first condition is `github_pr_merged`
  (`gh pr view --json state`: success on MERGED, failure on CLOSED, keep waiting
  on OPEN), with an optional `timeout_seconds`. Replaces the agent_task poll-loop
  stopgap so "merge the PR → release publishes" costs zero workers and no chat.
  (An instant GitHub-webhook resolution is the optimal form but needs upstream
  Hermes event→run wiring; the tick-poll works today.)

### Changed

- All dashboard styling moved to token-driven `hw-` classes in `theme.css`;
  no inline `style` objects remain.
- The editor adds nodes from a toolbar Add-node menu instead of a side palette,
  and a freshly added node opens directly in the inspector.
- The dashboard test suite runs test files sequentially with a 30s per-test
  timeout, so the in-suite bundle build cannot starve interaction tests on a
  loaded machine.
- The tick detects a blocked underlying card and delivers one ATTENTION notice
  per card (naming it and how to recover) instead of leaving the run silently
  inert; the run stays active and resumes when the card is unblocked.
- `hermes-workflows status` opportunistically read-only-polls each active node's
  card and reports live state and pending completions, so it no longer lags the
  tick (the "looks stuck" confusion).
- The on-disk spec serializer emits `|` block scalars for multiline strings
  (prompts/commands) when lossless, keeping a hand-authored spec readable across
  the round trip instead of one-line quoted `"...\n..."` strings.
- The `human_review` waiting notice is now an actionable ACTION NEEDED message
  (the gate, the allowed decisions, how to resolve).
- Operator->run channel: replying in a paused run's origin chat with a decision
  (`approved` / `rejected` / `needs_changes`, optionally a note) resolves that
  gate. A `pre_gateway_dispatch` hook routes the reply to the run instead of
  letting the gateway agent swallow it. Deterministic and language-agnostic
  (exact decision tokens only), routed only when the chat has exactly one waiting
  gate; otherwise it falls through to `/workflow review` or the dashboard.
- Script-node commands always receive `HOME` so HOME-credential CLIs (claude,
  codex, gh, …) resolve their config; the agent bash-tool HOME caveat is
  documented.

### Removed

- `NodePalette` component (superseded by the toolbar Add-node menu).

### Fixed

- `GET /o2b-status` now resolves the OpenSecondBrain CLI and config from the
  filesystem (home from the passwd database) instead of probing `o2b status`
  in a subprocess, which misreported "not connected" under the dashboard
  service's sanitized environment.

## 0.1.0 - 2026-05-30

The editor backend foundation plus the visual `@xyflow/react` editor and live
run inspector it drives.

### Added

- Typed, lenient `ui.xyflow` layout (node positions + viewport) on the workflow
  schema. A spec without `ui` still loads and runs; malformed layout is dropped.
- Zero-dependency workflow serializer. `parseWorkflow(serializeWorkflow(w, ui))`
  round-trips losslessly (YAML structure, scalars via `JSON.stringify`), so the
  project keeps no runtime dependencies.
- Spec write path in the core `SpecStore`: `getById`, `saveWorkflow` (validates
  before writing, so no invalid spec is persisted), `createWorkflow`,
  `deleteSpec`, and scope-based root routing (`chooseWriteRoot`).
- Core CLI subcommands `spec-get`, `spec-save`, `spec-create`, `spec-delete`.
- Run mutations `cancelRun` and `retryRun` (whole-run or one failed node), exposed
  as the `run-cancel` and `run-retry` CLI subcommands.
- Dashboard HTTP routes for the editor: `GET`/`PUT /workflows/{id}`,
  `POST /workflows/{id}/validate`, `.../compile-preview`, `.../run`,
  `GET /runs/{id}`, `POST /runs/{id}/cancel`, `POST /runs/{id}/retry`. Invalid
  graphs and id mismatches return `400`; missing workflows/runs return `404`;
  unexpected core failures return `500` (the core CLI emits a structured error
  kind the bridge maps to a status).
- Dashboard frontend (`apps/dashboard`, Vite + React 19 + `@xyflow/react`) built
  to a single committed bundle (`dashboard/dist/index.js` + `index.css`). It
  reuses the host's React via a shim (no second React ships) and bundles a
  pinned `react-dom` for `@xyflow/react`; the manifest's `css` entry loads the
  stylesheet.
- Visual editor: a flow canvas with a node palette, a per-type node inspector
  (agent_task profile/model/skills/prompt, human_review options, finish outcome),
  and validation + compile-preview panels. The layout round-trips losslessly
  through `ui.xyflow`, and Save persists `{ workflow, ui }`.
- Templates page (list, open, run) and a live run inspector that polls the run,
  colours nodes by status, and offers whole-run cancel/retry and per-node retry.
- Dashboard workflow authoring lifecycle: create a workflow from a modal
  (name/scope/trigger; the id is generated, not user-entered), seeded with a
  minimal valid graph and opened straight in the editor; duplicate under a new id;
  export the canonical YAML; and delete
  with confirmation. Backed by `POST /workflows` (refuse-overwrite; a clashing id
  is `409`, an invalid graph `400`), `DELETE /workflows/{id}` (`404` if absent),
  and `GET /workflows/{id}/export` (the on-disk YAML in a JSON envelope, so no
  second serializer ships to the browser). The core gains a distinct
  `SpecExistsError` so the bridge can map a duplicate id to `409`.
- Typed API client over the host `fetchJSON`, sharing spec/run/plan types from
  `@hermes-workflows/core` via type-only imports.
- Root `dashboard:*` scripts and a `bun run validate` that builds the frontend
  and guards that the committed `dashboard/dist` matches a fresh build.
- Runs page: lists every run (not just active) with run id, workflow, project,
  status, current node, started/finished, and duration, plus row actions Open
  (inspector), Cancel, Retry node, Retry run, and Export logs. Backed by
  `GET /runs?scope=active|all` (active stays the default for back-compat) and
  `GET /runs/{id}/export` (the full run-load bundle in a JSON envelope). A core
  `run-list-summary` command returns a flat `RunSummary` with timing meta and a
  derived current node; the existing `run-list` is unchanged.
- Schedules page: lists each workflow cron schedule (workflow, cron expression,
  timezone, enabled, last/next run, Hermes Cron ID) with row actions Pause,
  Resume, Run now, Edit (cron expression), and Delete. Backed by `GET /schedules`,
  `POST /schedules/{id}/pause|resume|run`, `PUT /schedules/{id}` (`400` on a bad
  cron), and `DELETE /schedules/{id}` (`404` if absent), all thin shells over the
  Hermes cron bridge — Hermes cron owns the schedules; the page edits the live
  job, not the on-disk spec.
- Settings page: a schema-driven form over storage / execution / kanban /
  open_second_brain, reading effective values (config ▸ env ▸ default) and
  persisting edits to the Hermes config `plugins.workflows` namespace via
  `GET`/`PUT /settings`. The `kanban.internal_board` setting is honoured by the
  runtime; other knobs are persisted and displayed but labelled not-yet-enforced
  pending engine wiring.
- Spec-level `enabled` flag (absent means enabled, so existing specs are
  unchanged) with an `isWorkflowEnabled` helper; non-boolean values are rejected
  at parse time. A core `run-latest` command and `latestRunByWorkflow` map each
  workflow to its most recent run.
- Templates page enable/disable: a Status badge plus Last run / Last status /
  Next run columns, and an Enable/Disable action per row. Backed by
  `PUT /workflows/{id}/enabled`, which writes the flag into the spec and
  pauses/resumes any cron job to match; a disabled workflow's Run action is
  disabled and `POST /workflows/{id}/run` returns `409`. The `GET /workflows`
  rows carry `enabled` and best-effort `last_run_at` / `last_status` /
  `next_run_at` columns.
- Editor node inspector exposes the full node field set: `description` on every
  node type, and for agent_task workdir, workspace type, max retries, timeout,
  and `input_mapping` (edited as key/value rows; a duplicate key is flagged and
  withheld so the saved spec never carries a collision). No schema change — the
  fields already existed in core.
- Editor canvas actions: **Duplicate node** (clone the selected node under a
  fresh id at an offset) and **Auto-layout** (a dependency-free layered layout
  that ranks nodes by longest forward distance, stacks branch siblings, trails
  disconnected nodes, and treats router loop-edges as back-edges). Both write
  through the existing save path and round-trip through `ui.xyflow`.
- `script` node type: a deterministic shell command run with no LLM (lint,
  tests, a build step) as a step in any workflow. `command` is required;
  `workdir`, `timeout_seconds`, and an `env` allowlist are optional. It settles
  `success`/`failure` by exit code, so existing `node_status` branching, the run
  inspector, retry, and cancel all apply unchanged. Scripts run locally in the
  plugin (a `ScriptExecutor` reusing the durable file-backed completion store)
  in any scope — the engine wraps the scope executor in a `CompositeExecutor`
  that routes by node kind. Security (TZ §25.2) is enforced: a workflow with
  script nodes runs only when `execution.scripts_enabled` is on, a script sees
  only the `execution.script_env_allowlist` env vars, runs in its `workdir`
  under a timeout, and its captured output is redacted. The editor offers the
  node in the palette/inspector and previews the compiled command before a run.
- Autonomous loop closed end to end. A run captures its chat `origin` (a
  `pre_gateway_dispatch` hook keyed by the gateway session, or a cron schedule's
  delivery target) and the engine delivers a single run-lifecycle notice on
  completed / failed / review-needed - through Hermes' native delivery to the
  origin or a configured default - while Kanban-backed cards are subscribed to
  their terminal events via the native notifier, so durable runs close the loop
  out-of-process. Notices are idempotent (persisted per-run markers) and
  fail-open (a delivery error never fails a run).
- Open Second Brain writes on lifecycle transitions: a `run_completed` event
  plus a terminal-run retrospective (the structured run summary - workflow,
  result, what happened, problems, follow-up) on a terminal run, one
  `node_failed` per failed node, and an optional `run_started` event. Writes route through the core
  memory provider via new `memory-event` / `memory-retro` CLI commands (the
  retrospective markdown is built in the core, not duplicated), gated by the now
  enforced `open_second_brain.{mode,write_run_summaries,write_node_failures,write_node_events}`
  settings, idempotent per event, and fail-open.
- Lightweight inline mode (TZ §18.2): when `execution.default_mode` is `direct`
  (or auto-eligible) the engine drains inline-eligible script-only steps
  synchronously within one call, so a script-only run finishes with no tick
  round-trip; a run that reaches an agent_task / human_review node parks it
  durably. `durable` keeps the unchanged one-step-per-tick behaviour. The
  `execution.default_mode` knob is now enforced.

### Removed

- Dead `workflow_schedules` store in the core `RunRepository` (table, types, and
  the five schedule methods). It was referenced only by tests; Hermes cron is the
  single source of truth for workflow schedules.

### Fixed

- Open Second Brain writes reach the real `o2b` CLI. The provider invoked
  `o2b brain note --kind … --title … --body …`, but the CLI takes a single
  positional `<text>` argument (with an optional `--agent`); the unsupported
  flags made every memory write a silent no-op (swallowed by fail-open). Writes
  now compose a one-line note (`[workflow:<kind>] <title> — <body>`, the
  retrospective markdown collapsed) tagged with `--agent hermes-workflows`, and
  the provider test asserts the real CLI contract.
- Production dashboard bundle loads under the host: `NODE_ENV` is inlined to
  `production` and the production JSX runtime is used, so the bundle no longer
  throws a `process is not defined` `ReferenceError` that prevented the plugin
  from calling `register()`.

### Security

- Workflow ids are validated against a slug charset, so an id can never escape
  the storage root via path traversal when written as `<root>/<id>.workflow.yaml`.
- Map keys (including user-controlled `agent_task.input_mapping` keys) are
  JSON-quoted on serialization, closing a YAML-injection / round-trip break.
