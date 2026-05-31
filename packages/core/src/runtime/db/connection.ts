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
  db.run("PRAGMA busy_timeout = 5000");
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
  const columns = new Set(
    (db.query("PRAGMA table_info(workflow_runs)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of ["origin", "notified"]) {
    if (!columns.has(name)) db.run(`ALTER TABLE workflow_runs ADD COLUMN ${name} TEXT`);
  }
}
