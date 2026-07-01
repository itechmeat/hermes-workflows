/**
 * Open (and initialise) a `runs.db` SQLite database. WAL plus a long busy
 * timeout because the transient advance tick and the dashboard read it
 * concurrently. Initialisation is idempotent.
 */

import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "./schema.ts";

export function openRunsDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // A generous busy timeout: the dashboard reads/writes in-process while the
  // advance tick's out-of-process core-CLI subprocess writes the same db. Under
  // load a writer can hold the lock for several seconds, so wait rather than
  // fail with SQLITE_BUSY ("database is locked").
  db.run("PRAGMA busy_timeout = 30000");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of SCHEMA_SQL.split(";")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) db.run(trimmed);
  }
  migrate(db);
  return db;
}

/**
 * Forward-compatible column additions for databases created before a column
 * existed. `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a
 * pre-existing `runs.db` would lack columns added to {@link SCHEMA_SQL} later;
 * add each missing one idempotently. A fresh database already has them, so this
 * is a no-op there.
 */
function migrate(db: Database): void {
  addMissingTextColumns(db, "workflow_runs", ["workflow_path", "origin", "notified", "params_json"]);
  addMissingTextColumns(db, "workflow_node_runs", [
    "node_type",
    "telemetry_json",
    "review_note",
    "driven_task_ids",
    "reviewed_task_ids",
    "wait_started_at",
    "adopt_seq_json",
    "adopt_blocked_since",
    "task_ids_json",
    "transient_retries",
    "retry_after",
  ]);
}

function addMissingTextColumns(db: Database, table: string, names: string[]): void {
  const columns = new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of names) {
    if (!columns.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
  }
}
