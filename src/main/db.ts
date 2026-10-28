import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/*
  One SQLite file: settings, and the tasks, steps and events of the event log. Each migration runs
  once, in order, recorded in `user_version`.
*/

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    source_root TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    specialist_cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX tasks_created ON tasks(created_at);

  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX steps_task ON steps(task_id, ord);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    step_id TEXT,
    agent TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX events_task ON events(task_id, id);

  CREATE TABLE patches (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    state TEXT NOT NULL,
    files TEXT NOT NULL,
    diff TEXT NOT NULL,
    conflicts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX patches_task ON patches(task_id);
  `,
]

let db: DatabaseSync | null = null

export function openDb(file: string): DatabaseSync {
  closeDb()
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const d = new DatabaseSync(file)
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
  migrate(d)
  db = d
  return d
}

export function migrate(d: DatabaseSync) {
  const version = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec("BEGIN")
    try {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
      d.exec("COMMIT")
    } catch (e) {
      d.exec("ROLLBACK")
      throw e
    }
  }
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("The database is not open.")
  return db
}

export function closeDb() {
  db?.close()
  db = null
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(key: string, value: unknown) {
  if (value === null || value === undefined) getDb().prepare("DELETE FROM settings WHERE key = ?").run(key)
  else getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value))
}
