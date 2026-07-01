# TRANSIENT-NODE-RETRY — plan

TDD, one shared branch `feat/transient-node-retry`.

1. **Red.** `tests/python/test_engine_transient_retry.py`: transient-then-succeed,
   exhaust-then-fail, deterministic-no-retry (project-scope spec, `max_retries: 1`,
   worker settles exit-0 429 summary). `tests/python/test_outcome.py`: `usage
   limit` sentinel. `packages/core/tests/db.test.ts`: `transient_retries` /
   `retry_after` round-trip.

2. **Green — Python.**
   - `executor/base.py`: `Completion.kind`.
   - `executor/kanban_executor.py`: `poll` forwards `read_completion`'s `kind`.
   - `executor/outcome.py`: add `usage limit` transient pattern.
   - `engine.py`: constructor `retry_policy`; node-loop re-schedule branch on
     `retry_after`; settle-block `_schedule_transient_retry` helper; `_schedule_node`
     iteration offset by `transient_retries`.

3. **Green — TS core (persist node retry state).**
   - `runtime/db/schema.ts`: `transient_retries` / `retry_after` columns.
   - `runtime/db/connection.ts`: add both to the idempotent migration.
   - `runtime/db/runRepository.ts`: `NodeRow`, upsert (cols/values/update/bind),
     load.
   - `schema/run.ts`: `NodeRunState` fields.

4. **Verify.** `bun run validate` at 0 errors.

5. **Release.** Bump `package.json` / `plugin.yaml` / `pyproject.toml` 0.7.6 →
   0.7.7; CHANGELOG `0.7.7`; self-review; push; PR; pause for operator merge.
