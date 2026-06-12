# Native Hermes alignment for Workflows — design

**Status:** draft
**Author:** Sol Aitken (via feature-release-playbook)
**Audience:** implementation

## Problem statement
Hermes shipped Automation Blueprints: single-prompt automations defined as one typed-slot schema,
rendered natively across surfaces (form / slash / agent-seed / `hermes://` deep-link / catalog) and
compiled to `cron.jobs.create_job`. Our Workflows are the complementary multi-node-DAG tier. This
epic makes Workflows maximally native and correct relative to Hermes by reusing the same primitives
and conventions blueprints use, without rebuilding what we already reuse natively (cron via
`cron.jobs`, delivery via the gateway `DeliveryRouter`, the host `/api/skills` catalog).

## Scope (one multi-task PR, TDD per feature)
- **F1 — Delivery first-class + `[SILENT]`** (`t_13d09914`). A workflow may declare a `deliver`
  target in the host `DeliveryTarget` syntax, default `origin`. When set, the run's result is
  delivered to that target on completion; a result containing `[SILENT]` suppresses delivery.
  Lifecycle behaviour is unchanged when `deliver` is unset.
- **F2 — Skills multi-select** (`t_6d2d4811`). The node inspector picks `agent_task.skills` from the
  host `/api/skills` catalog via a multi-select, preserving unknown/legacy values.
- **F3 — Typed-param templates + per-surface emitters, native layer** (`t_959ae539`). A workflow
  template gains typed parameters (mirroring `BlueprintSlot`) as the single source of truth, plus
  pure emitters: form schema, `/workflow` slash string, `hermes://` deep-link, catalog entry,
  agent-seed prompt. The dashboard "new workflow" form consumes the same schema.
- **F4 — Webhook/GitHub/API triggers, native layer** (`t_d7809a7a`). The `Trigger` union gains
  `webhook`/`github`/`api` variants with an event filter and an `{event.*}` template namespace;
  validation + compile-preview surface them.
- **F5 — Positioning + Schedules coexistence** (`t_d468bc7e`). Docs position Workflows as the
  multi-node layer above blueprints; the Schedules page labels workflow-trigger cron jobs distinctly.

## Out of scope (host-gated — no stubs)
- **F3 live surfaces**: a working `/workflow` chat slash command and OS `hermes://` deep-link
  resolution need host handlers (the host has a single `/blueprint` handler + `hermes://blueprint/...`
  scheme we cannot add). We ship only the pure emitter strings + the dashboard form. A board comment
  records the upstream-Hermes ask.
- **F4 firing**: the host webhook system dispatches events only to agent prompts or `deliver_only`
  direct delivery — there is no deterministic event→job wiring and `cron.jobs.create_job` is
  time-only. We add the schema/validation/preview but NO bridge that pretends to fire. A board
  comment records the upstream-Hermes ask (add a `script`/`no_agent` subscription mode or an
  event→job bridge).
- Migrating the live o2b-scope-suggester spec/template off `/tmp` (`t_f6620f4c`) — runtime config
  under `/root/.hermes`, excluded from this run by the operator.

## Chosen approach
Variant 1 — host-mirror in TS core. The TS engine stays the single spec interpreter; new schema
fields mirror the on-disk spec 1:1; emitters are pure functions paralleling `blueprint_catalog.py`,
unit-tested under `bun test`. Python stays I/O-only (delivery-target resolution + `[SILENT]`,
trigger compile-preview). The dashboard consumes emitter output through the plugin API.

## Design decisions

### F1 — delivery + `[SILENT]`
- **Schema.** Add `Workflow.deliver?: string` (DeliveryTarget syntax or the literal `"origin"`).
  Accept any non-empty string — the gateway validates platforms downstream (mirror the blueprint
  `_DELIVER` slot `strict=False`); we do NOT hardcode a closed platform list. A light structural
  check only rejects an empty/whitespace string.
- **No run-record duplication.** `deliver` is a static spec property (identical every run), unlike
  `origin` (captured per run), so it is NOT persisted on the run / in `runs.db` — that would
  duplicate spec data and need a DB migration. The engine reads `deliver` from the `compile-preview`
  plan it already fetches every advance step (`_advance_step` calls `compile-preview`), so the spec
  stays the single source of truth (interpreted by TS) with no extra subprocess.
- **Target precedence (pure, in `notifications.resolve_target`).** Extend to
  `resolve_target(origin, default, deliver)`: an explicit `deliver` other than `"origin"` wins;
  `"origin"`/unset keeps today's `origin or default`. No platform branching.
- **Result delivery on completion.** When `deliver` is set, the `completed` notice text becomes the
  run's final result (the terminal/finish node's output, or the last completed node's output) rather
  than the terse lifecycle string, so a delivered workflow actually sends its result. `failed`/
  `waiting` notices stay lifecycle text. When `deliver` is unset → today's behaviour exactly.
- **`[SILENT]`.** A pure helper `is_silenced(text) -> bool` (`"[SILENT]" in text`, case-sensitive,
  matching the host marker). In `_notify`, when the resolved notice text is silenced, suppress: do
  not call the sender, and return `True` (nothing to deliver, ever — do not retry). Only meaningful
  when `deliver` is set (lifecycle text never contains the marker), so behaviour is consistent.
- **Compiler.** Surface `deliver` on `HermesPlan` (preview only) when present, so the dashboard
  compile-preview shows where a run's result goes. Pure; no firing.
- **Fail-loud.** No silent fallback: an unset `deliver` is the documented unchanged path, not a
  swallowed error.

### F2 — skills multi-select
- Replace the free-text comma-separated `skills` field in `NodeInspector` with a multi-select backed
  by `listSkills()` (`/api/skills`). Preserve any current value absent from the catalog (mirror the
  existing model/profile "preserve unknown" narrowing already in NodeInspector + `normalizeImport`).
- Base UI component consistent with `DESIGN.md`. Base UI has no multi-select primitive; build it from
  the documented Checkbox list (a labelled checkbox per catalog skill + a preserved-unknown group),
  not a new bespoke control — keeps the kit honest. Selection writes back the string array.

### F3 — typed-param templates + emitters (native layer)
- New TS module `packages/core/src/templates/params.ts` (pure), paralleling `blueprint_catalog.py`:
  - `WorkflowParam` interface: `{ name; type: "text"|"enum"|"int"|"bool"; label; default?; options?;
    optional?; strict?; help? }` (mirrors `BlueprintSlot`; `strict=false` enum = open suggestions).
  - `paramFormSchema(params)` → form JSON (one field per param).
  - `paramSlashCommand(name, params, values?)` → `/workflow <name> slot=val …` (quote text/spaces).
  - `paramDeeplink(name, params, values?)` → `hermes://workflow/<name>?slot=val`.
  - `catalogEntry(template)` → unified shape (form schema + command + appUrl + description).
  - `agentSeed(template)` → the natural-language fill request (mirrors `build_blueprint_seed`).
  - `fillParams(params, values)` → validated values or throws `ParamFillError` (unknown param
    rejected; required checked; strict enum checked) — the validation half of the contract.
- A workflow TEMPLATE gains `params?: WorkflowParam[]`. The dashboard "new workflow" modal renders
  the form from `paramFormSchema` and substitutes values into the seeded spec.
- Live slash/deeplink resolution is host-gated (out of scope); the emitters produce real strings for
  docs/catalog/copy-paste now.

### F4 — triggers (native layer)
- Extend the `Trigger` union with `WebhookTrigger`/`GithubTrigger`/`ApiTrigger`. Shared shape:
  an `events: string[]` filter (e.g. `["pull_request","issues"]`) and an `event_mapping?:
  Record<string,string>` carrying `{event.<path>}` references substituted into the entry node's
  prompt (a separate namespace from `{{nodes.X.output}}`). GitHub is webhook with a github source
  discriminator; API is a generic inbound POST.
- Validation: each event-trigger requires at least one event; `event_mapping` values must reference
  the `{event.*}` namespace. Compile-preview surfaces the trigger verbatim (no `cron_jobs` entry;
  these are not time-based).
- NO Python bridge that registers a host subscription — firing is host-gated (documented).

### F5 — positioning + Schedules
- README + DESIGN: a short section positioning Workflows as the multi-node layer above blueprints
  (branching, `human_review`, inter-node data flow), complementary not competing.
- Schedules page: label the `workflow:`-prefixed cron jobs as "Workflow" so they read distinctly
  from blueprint cron jobs that coexist on the host Schedules surface. No engine change.

## File changes
- TS schema: `packages/core/src/schema/workflow.ts` (`deliver`, extended `Trigger`), parsed in
  `schema/load.ts` (`fromObject`/`parseTrigger`); the generic serializer round-trips them.
- TS compiler: `compiler/compileToHermesPlan.ts` (surface `deliver` + event triggers in preview;
  the engine reads `plan.deliver` rather than a run-record field).
- TS validation: the spec validator module (extend for `deliver` + event triggers).
- TS templates: new `packages/core/src/templates/params.ts` (params + emitters + `fillParams`).
- Python: `hermes_workflows/notifications.py` (`resolve_target` deliver arg, `is_silenced`),
  `engine.py` (`_notify` reads `run.deliver`, result text on completion, `[SILENT]` suppression).
- Dashboard: `editor/NodeInspector.tsx` (skills multi-select), `templates/NewWorkflowModal.tsx` +
  `templates/seed.ts` (typed params form), `pages/SchedulesPage.tsx` (labeling),
  `api/client.ts`/`types.ts` as needed.
- Docs: `README.md`, `DESIGN.md`, `CHANGELOG.md`.
- Tests: TS (`packages/core/tests` for schema/compiler/params/validation), Python
  (`tests/python` for delivery target + `[SILENT]`), dashboard vitest (NodeInspector, NewWorkflowModal,
  Schedules), rebuilt `dashboard/dist`.

## Risks and open questions
- **F1 result text source.** "The run's result" = terminal/finish node output. A multi-terminal
  graph picks the last completed terminal node deterministically (highest `seq`). Documented; covered
  by a Python unit test.
- **F1 lifecycle parity.** The "unchanged when unset" guarantee must be proven by a regression test
  that an unset `deliver` produces byte-identical notice behaviour.
- **F2 multi-select fidelity.** No Base UI multi-select primitive; composed from Checkboxes per
  `DESIGN.md`. jsdom test queries by role, not label.
- **F3/F4 host gating.** The emitters/schema are real and tested; the live slash/deeplink and event
  firing are deferred upstream. The PR must clearly state this so the partial children are not read
  as fully shipped; board comments capture the upstream asks.
- **Dist guard.** The committed `dashboard/dist` is rebuilt in the same PR.
