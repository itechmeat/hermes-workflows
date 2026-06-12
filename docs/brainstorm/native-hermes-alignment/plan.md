# Native Hermes alignment — implementation plan

Implementation is TDD per feature on branch `feat/native-hermes-alignment`. Format + lint
(`bun run fmt && bun run lint`) before every commit. One atomic commit per feature.

## Task F1: Delivery first-class + `[SILENT]` (t_13d09914)
- **Files**: `packages/core/src/schema/workflow.ts`, `schema/run.ts`, `runtime/state.ts`,
  `compiler/compileToHermesPlan.ts`, the validator; `hermes_workflows/notifications.py`,
  `hermes_workflows/engine.py`.
- **Tests first**:
  - TS: `deliver` accepted on a workflow; rejected when empty/whitespace; `createRunState` stamps
    `run.deliver` from `workflow.deliver`; compile-preview surfaces `deliver`.
  - Python: `resolve_target(origin, default, deliver)` precedence (explicit non-origin wins;
    `"origin"`/None → origin or default); `is_silenced` true/false; `_notify` on a completed run with
    `deliver` set delivers the final node output to the target; `[SILENT]` in the output suppresses
    (sender not called, marked done); unset `deliver` → identical to today (regression).
- **Acceptance**: a workflow can declare where its result is delivered using host target syntax;
  `[SILENT]` suppresses; lifecycle unchanged when unset; all tests green.
- **Depends on**: none.

## Task F2: Skills multi-select (t_6d2d4811)
- **Files**: `apps/dashboard/src/editor/NodeInspector.tsx` (+ a small multi-select built from the
  Base UI Checkbox kit if not reusable inline), `apps/dashboard/tests/node-inspector.test.tsx`,
  `apps/dashboard/src/api/client.ts`/`types.ts` if needed.
- **Tests first**: the inspector renders a checkbox per catalog skill from `listSkills`; toggling
  writes the `skills` array; a legacy value absent from the catalog is preserved and selectable.
- **Acceptance**: skills chosen from the host catalog via multi-select; unknown/legacy preserved.
- **Depends on**: none (independent of F1).

## Task F3: Typed-param templates + emitters, native layer (t_959ae539)
- **Files**: new `packages/core/src/templates/params.ts`; template schema field `params?` on the
  workflow/template type; `apps/dashboard/src/templates/NewWorkflowModal.tsx` + `seed.ts`; tests
  `packages/core/tests/params.test.ts`, `apps/dashboard/tests/new-workflow-modal.test.tsx`.
- **Tests first**:
  - `paramFormSchema` shape; `paramSlashCommand` quoting; `paramDeeplink` encoding; `catalogEntry`
    unified shape; `agentSeed` includes each param + default; `fillParams` rejects unknown param,
    enforces required, checks strict enum (`ParamFillError`).
  - Dashboard: the new-workflow form renders one field per param and substitutes values.
- **Acceptance**: a parameterized template instantiates from the dashboard form off the same schema;
  the slash/deeplink/catalog/agent-seed emitters produce correct strings.
- **Board comment**: record the upstream-Hermes ask for a live `/workflow` handler + `hermes://`
  workflow scheme on `t_959ae539`.
- **Depends on**: none.

## Task F4: Webhook/GitHub/API triggers, native layer (t_d7809a7a)
- **Files**: `packages/core/src/schema/workflow.ts` (Trigger union), the validator,
  `compiler/compileToHermesPlan.ts`; tests `packages/core/tests/{schema,compiler,validate}*`.
- **Tests first**: each new trigger validates with ≥1 event and an `{event.*}` mapping; an empty
  events list rejects; compile-preview surfaces the trigger and emits no `cron_jobs` entry.
- **Acceptance**: webhook/github/api triggers declarable, validated, and shown in compile-preview;
  no stub firing path.
- **Board comment**: record the upstream-Hermes ask for an event→workflow-run wiring (script/
  no_agent subscription mode) on `t_d7809a7a`.
- **Depends on**: none.

## Task F5: Positioning + Schedules labeling (t_d468bc7e)
- **Files**: `README.md`, `DESIGN.md`, `apps/dashboard/src/pages/SchedulesPage.tsx`, test
  `apps/dashboard/tests/schedules-page.test.tsx`.
- **Tests first**: the Schedules page labels a `workflow:`-prefixed job as a Workflow trigger.
- **Acceptance**: docs state the Workflows↔Blueprints relationship; Schedules attributes job kind.
- **Depends on**: none.

## Task QA + bundle
- **Files**: rebuilt `dashboard/dist`.
- **Acceptance**: `bun run validate` green (typecheck, lint, TS test, pytest, dashboard
  typecheck/test/build, dist guard); manual smoke of editor/new-workflow/schedules if feasible.
- **Depends on**: F1-F5.
