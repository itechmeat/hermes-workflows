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
  -- JSON arrays for adopt nodes: the existing card ids the node drives, and the
  -- subset already routed through the native review stage. Added after the
  -- initial schema, so connection.ts ALTERs pre-existing databases.
  driven_task_ids TEXT,
  reviewed_task_ids TEXT,
  -- Epoch seconds a wait node began polling (for its optional timeout). Added
  -- after the initial schema, so connection.ts ALTERs pre-existing databases.
  wait_started_at TEXT,
  -- JSON bookkeeping for a sequential adopt node (pending ids, assignee,
  -- accumulated outputs/failed). Added after the initial schema, so
  -- connection.ts ALTERs pre-existing databases.
  adopt_seq_json  TEXT,
  -- JSON array of board task ids the node resolved, captured from a structured
  -- task_ids block in its worker output (read by an adopt task_ids reference in
  -- preference to scraping prose). Added after the initial schema, so
  -- connection.ts ALTERs pre-existing databases.
  task_ids_json   TEXT,
  outcome         TEXT,
  review_decision TEXT,
  -- Optional operator free-text payload attached when resolving a human_review
  -- gate, consumable downstream as {{nodes.<gate>.review_note}}. Added after the
  -- initial schema, so connection.ts ALTERs pre-existing databases.
  review_note     TEXT,
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
