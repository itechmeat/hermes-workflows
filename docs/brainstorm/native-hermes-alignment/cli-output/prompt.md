You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Make a Hermes "Workflows" plugin (multi-node DAG automations) maximally NATIVE and CORRECT relative to the host Hermes agent after Hermes shipped "Automation Blueprints" (single-prompt automations defined as one typed-slot schema, rendered natively across surfaces: dashboard form, `/blueprint` slash command, agent-seed, `hermes://` deep-link, docs catalog; compiling to `cron.jobs.create_job` — no second job engine).

This brainstorm covers the IN-REPO native layer of a 5-part epic. Two parts are partly host-gated (the host lacks the hooks; we ship only the real in-repo layer, no stubs):

1. Delivery as a first-class workflow-schema concept + `[SILENT]` suppression. Today the plugin delivers terse run-lifecycle notices to the run's captured chat origin or a configured default, via the host's native DeliveryRouter. We want a workflow (or terminal node) to DECLARE a `deliver` target in the host's `DeliveryTarget` syntax (e.g. `telegram:-100123:42`, `discord`, `email`, `local`), default `origin`. When set, the run's RESULT is delivered to that target on completion; an output containing `[SILENT]` suppresses delivery (no notification spam). Lifecycle behavior unchanged when `deliver` is unset.

2. Typed-parameter workflow templates + per-surface emitters (host-gated for live slash/deeplink). Mirror the blueprint's `BlueprintSlot` (name/type/label/default/options/optional/strict): give a workflow TEMPLATE typed parameters as the single source of truth, and emit per-surface renderings as PURE functions: a dashboard form schema, a ready-to-paste `/workflow <name> slot=val` slash string, a `hermes://` deep-link, a docs catalog entry, and an agent-seed prompt. The dashboard "new workflow" form consumes the same schema. (Live chat slash command + OS deep-link resolution need host handlers we cannot add; only the emitters + form are in scope.)

3. Webhook/GitHub-event/API triggers — schema/validation/compile-preview only (host-gated firing). Extend the workflow `Trigger` union (today `manual | cron`) with `webhook`/`github`/`api` variants carrying an event filter and an `{event.*}` template namespace mapped into the entry node's prompt. Validation + compile-preview surface them. (The host webhook system dispatches events only to agent prompts or direct delivery — there is NO deterministic event→workflow-run wiring and `create_job` is time-only — so actual firing is deferred to an upstream Hermes change; we add NO stub that pretends to fire.)

4. Skills multi-select in the node inspector — replace a free-text comma-separated `skills` field with a multi-select backed by the host `/api/skills` catalog, preserving unknown/legacy values (mirror the existing model/profile "preserve unknown" pattern).

5. Positioning/terminology + Schedules-page coexistence — docs positioning Workflows as the multi-node layer ABOVE blueprints; label workflow-trigger cron jobs distinctly from blueprint cron jobs on the Schedules page.

# Project context

Hermes Workflows plugin. TypeScript core (`packages/core`, Bun runtime, pure engine + spec schema + compiler) invoked out-of-process by a Python orchestrator (`hermes_workflows/`), plus a FastAPI dashboard plugin API and a React 19 dashboard (`apps/dashboard`, committed to `dashboard/dist`). The TS engine is the single interpreter of the spec; Python executes its decisions.

Key facts:
- Workflow schema is TS interfaces in `packages/core/src/schema/{workflow,nodes,run}.ts`; field names mirror the on-disk YAML/JSON spec 1:1. `Trigger = ManualTrigger | CronTrigger`. `AgentTaskNode` already has `input_mapping?: Record<string,string>` for `{{nodes.X.output}}` references.
- The compiler `packages/core/src/compiler/compileToHermesPlan.ts` is PURE (no I/O) and produces a `HermesPlan` preview (kanban_tasks, script_steps, cron_jobs, profiles, skills, memory). It powers the dashboard "compile preview".
- Cron triggers are compiled to a native `cron.jobs.create_job` job in `hermes_workflows/bridge/cron.py` via an agent-less script shim (`no_agent=True`, `script=<shim>`) that execs `hermes-workflows run <id>`. We NEVER write our own cron engine.
- Delivery: `hermes_workflows/notify_sender.py` builds a `Sender((target,message)->bool)` over the host `gateway/delivery.py` `DeliveryRouter`; `notifications.notify_run(...)` resolves target = `origin or default`; `engine.py::_notify` fires lifecycle notices with terse `_notice_text`. The run record (`RunState` in `run.ts`, persisted in `runs.db`) carries `origin?` and `notified?[]` markers (idempotent per (run,event)). `createRunState(workflow, runId, projectId, origin)` builds the run; `cmdRunCreate` calls it.
- The host blueprint module (`cron/blueprint_catalog.py`) is the reference: `BlueprintSlot` dataclass, `blueprint_form_schema`/`blueprint_slash_command`/`blueprint_deeplink`/`blueprint_catalog_entry`/`fill_blueprint` pure functions, `BlueprintFillError` for validation (unknown slot rejected, enum checked, `strict=False` slots accept any value validated downstream).
- Dashboard component kit is Base UI wrappers under `apps/dashboard/src/ui/components/` (Input/Select/Checkbox/Switch/Textarea/Button), documented in `DESIGN.md`. `api/client.ts#listSkills()` already calls `/api/skills`. NodeInspector preserves a current model/profile value not present in the catalog.
- Tests: `bun test packages/core` (TS), `pytest` (Python), vitest for dashboard. Lint `oxlint`, format `oxfmt`, dist guard `git diff --exit-code dashboard/dist`.

Recent commits:
454da3e feat(dashboard): Base UI controls + O2B indicator link + import normalisation
96f30a4 feat: inter-node data flow via input_mapping (no host-file handoffs)
3d3c15c fix: honor per-node model/provider/skills/timeout for global runs
65bc8a6 feat: single-flight runs + workflow JSON export/import

Conventions:
- SOLID/KISS/DRY; extract repeated literals to constants. NO fallbacks that silently do nothing; surface errors explicitly. NO stubs. Never reinvent a host primitive — reuse `cron.jobs`, `DeliveryRouter`, `/api/skills`.
- Field names mirror the on-disk spec 1:1; the TS engine is the one spec interpreter.
- Never propose diverging from Hermes conventions/schema; any host change is an upstream concern, not a local workaround.

Constraints:
- Do not change the host Hermes source (out of our control). In-repo only.
- Keep the compiler pure. Keep delivery on the native DeliveryRouter. Keep cron on `cron.jobs`.
- `deliver` validation: accept any DeliveryTarget-shaped string (the gateway validates platforms downstream — mirror blueprint `strict=False`); do not hardcode a closed platform list.
- These 5 ship in ONE multi-task PR on one branch; implementation is TDD per feature.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
