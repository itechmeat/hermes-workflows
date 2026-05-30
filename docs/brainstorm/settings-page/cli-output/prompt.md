You are a frontend+backend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Settings page in the Hermes Workflows dashboard, TZ §20.10)

Add a Settings page exposing, grouped: storage (global_workflows_path, runs_db_path); execution (default_mode, max_parallel_runs, default_timeout_seconds); kanban (use_workflow_columns, internal_board); open_second_brain (mode, fail_open, write_run_summaries, write_node_failures, write_node_events). Read effective values and persist edits.

Already exists (reuse): Hermes has a config system — `config.yaml` with a schema, defaults, and dashboard endpoints `GET /api/config`, `GET /api/config/schema`, `GET /api/config/defaults`, `PUT /api/config`, and a `plugins:` config section. The plugin's `config.py` already centralises every knob it reads, with env/default fallback. The host design-system components and the project's `hw-` theme tokens are available (the host's generic AutoField is not exposed to plugins).

# Constraints
- Reuse Hermes facilities where they exist; do not build a parallel config store/schema if the host already provides one. Pure TS core owns spec/run logic; Python is a thin shell.
- Must not break existing env-driven deployments: effective value = config ▸ env ▸ default.
- Frontend builds to one Vite bundle; the API client is injected for tests; oxlint zero warnings.
- Operator chats in Russian; repo artifacts stay English.
- Out of scope: wiring every knob into runtime behaviour (some are persisted/displayed with a follow-up to enforce); editing arbitrary Hermes config beyond the plugin namespace.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons), Complexity (small|medium|large), Risk (low|medium|high). Differ on where settings live: (a) the Hermes config `plugins.workflows` namespace via the host config path; (b) a bespoke plugin-owned settings file; (c) env-only, surfaced read-only. Then exactly one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.
