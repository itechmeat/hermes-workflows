You are a backend architecture consultant brainstorming ARCHITECTURAL VARIANTS
for one epic. Do NOT write code, do NOT write a final design. Output exactly 3
variants and one recommendation.

# Task (Close the autonomous loop in Hermes Workflows)

Wire three already-built-but-unconnected pieces into the live run path, in one PR:
1. Notifications — capture a run's chat origin and deliver a run-lifecycle notice
   (completed / failed / review-needed); subscribe the origin to Kanban-backed
   nodes' terminal events.
2. Open Second Brain writes — emit run_started (optional) / node_failed /
   run_completed / a retrospective on lifecycle transitions.
3. Lightweight inline mode (§18.2) — a script-only run advances synchronously to
   finish with no tick round-trip; a run hitting an agent_task / human_review
   node falls back to durable mode.

Already exists (audited):
- A pure TypeScript core owns the spec (schema, validation, `compileToHermesPlan`,
  the `advance` engine) via a JSON CLI. A thin Python orchestrator (`engine.py`)
  drives runs, detects transitions (it sets terminal status after each advance),
  and owns the executor seam (Kanban / Direct / Script via a CompositeExecutor).
- `notifications.py` (resolve_target / parse_origin / subscribe_task / notify_run)
  and the Kanban notifier bridge exist but are unwired. Hermes provides
  `gateway/delivery.py` (DeliveryTarget.parse + DeliveryRouter.deliver) and
  `SessionSource` (origin), reachable only via a `pre_gateway_dispatch` hook —
  tool handlers do NOT receive the source.
- The memory seam (`WorkflowMemoryProvider` + O2B/FailOpen/Noop providers) is in
  the TypeScript core and shells to the O2B CLI; the Python engine drives runs
  through the core CLI.
- `execution.default_mode` and `open_second_brain.*` settings exist but are
  labelled not-yet-enforced.

# Constraints
- Reuse Hermes primitives (delivery, notifier, cron) and the plugin's own
  already-built modules; do not reinvent them. Do not build a general workflow
  engine or event bus (the spec forbids becoming an n8n clone).
- Keep the durable advance loop (schedule → poll → ingest) intact; inline mode is
  an addition, not a rewrite. Effects must be idempotent (once per run+event) and
  fail-open (a delivery / memory error never fails a run).
- Operator chats in Russian; repo artifacts stay English.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons),
Complexity (small|medium|large), Risk (low|medium|high). Differ on WHERE
run-lifecycle effects (notifications, memory writes) are produced and where the
inline loop lives — the real architectural axis (delivery-target parsing,
settings, and retrospective markdown are mechanical): e.g. (a) effects emitted by
the core advance and executed by the thin Python layer; (b) effects orchestrated
in the Python engine, core gaining only the minimal data it must own; (c) an
event-sourced run-event log with notification / memory subscribers. Then exactly
one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing
outside these sections.
