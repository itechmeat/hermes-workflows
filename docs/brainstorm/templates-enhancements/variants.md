# Brainstorm — Templates page enhancements (TZ §20.2)

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints as the runs/schedules/settings round); an in-process
orchestrator pass produced the variants. The orchestrator decides.

## Hermes / existing reuse audit

- The workflow schema has **no** `enabled`/`disabled` field today, and nothing
  gates a run on enabled state — so enable/disable is genuinely new behaviour,
  not a missing toggle over something Hermes owns.
- **Cron** owns the auto-trigger: a cron-triggered workflow is a native Hermes
  cron job, and the plugin already bridges `pause`/`resume` and surfaces
  `next_run_at` (Schedules epic). So for cron workflows, "disabled" maps onto the
  cron job's enabled flag, and the **Next run** column reuses the cron bridge.
- **Run history** lives in `runs.db`; `RunRepository.listRunSummaries` already
  exists. **Last run / Last status** need the latest run per workflow — a small
  aggregation over the existing store (no new Hermes primitive).
- Host DS + `hw-` tokens render the new column/control.

## Variants (where the enabled state lives)

- **Variant 1 — Spec-level `enabled` field in the core schema.** Add
  `enabled?: boolean` (default true) to the workflow spec; disabling blocks a
  manual `POST /run` (409) and pauses the workflow's cron job if one exists
  (reusing the cron bridge); enabling resumes it. One honest model that covers
  both manual and cron workflows; `enabled` round-trips through the spec like any
  other field. Pro: complete, no parallel store, reuses cron for the auto-trigger
  side. Con: a small core change (schema + run gate). Complexity: medium. Risk:
  low.
- **Variant 2 — Cron-only enable/disable.** Enable/Disable simply toggles the
  Hermes cron job (pause/resume). Pro: pure reuse, zero core change. Con: a
  manual workflow has no cron job, so the toggle is a no-op / hidden for the
  majority case — it does not actually disable manual runs, under-delivering
  TZ §20.2. Complexity: small. Risk: low but incomplete.
- **Variant 3 — Plugin-owned sidecar store of disabled ids.** A small DB/JSON of
  disabled workflow ids checked by the run path. Pro: no core schema change. Con:
  reintroduces exactly the parallel-state-store pattern we just deleted
  (`workflow_schedules`); a second source of truth for a property that belongs on
  the spec. Complexity: medium. Risk: medium.

## Recommended: Variant 1

The enabled state is a property of the workflow, not of its trigger, so it
belongs on the spec where it round-trips with everything else and stays the
single source of truth. Variant 1 gates manual runs honestly and reuses the cron
bridge for the auto-trigger side; Variant 2 silently fails to disable manual
workflows; Variant 3 reintroduces the parallel store we just removed. The
Last run / Last status / Next run columns are pure aggregation over the existing
run store plus the cron bridge — no new Hermes primitive.
