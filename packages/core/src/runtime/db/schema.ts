/**
 * SQLite schema for `runs.db` — the source of truth for workflow run state.
 * Embedded as a string (rather than a .sql file) so the core stays
 * path-agnostic and needs no file resolution at load time.
 *
 * One `workflow_node_runs` row per (run, node): it holds the *current* node
 * state used to reconstruct a RunState. Full per-attempt history lives natively
 * in Hermes `task_runs`, not here. Cron schedules are owned entirely by Hermes
 * cron (see `hermes_workflows/bridge/cron.py`), so there is no schedule table.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL,
  workflow_version INTEGER,
  status           TEXT NOT NULL,
  project_id       TEXT,
  input_json       TEXT,
  started_at       INTEGER,
  finished_at      INTEGER,
  error            TEXT,
  -- Chat origin (platform:chat[:thread]) and lifecycle-effect markers (JSON
  -- array) for run-lifecycle notifications and memory writes. Added after the
  -- initial schema, so connection.ts ALTERs pre-existing databases.
  origin           TEXT,
  notified         TEXT
);

CREATE TABLE IF NOT EXISTS workflow_node_runs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  hermes_task_id  TEXT,
  outcome         TEXT,
  review_decision TEXT,
  seq             INTEGER,
  output_json     TEXT,
  error           TEXT,
  -- Observer-derived agent telemetry (JSON NodeTelemetry), merged by the
  -- bridge at settle time. Added after the initial schema, so connection.ts
  -- ALTERs pre-existing databases.
  telemetry_json  TEXT,
  FOREIGN KEY(run_id) REFERENCES workflow_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_runs_status      ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_node_runs_run    ON workflow_node_runs(run_id);
`;
