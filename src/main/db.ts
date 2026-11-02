import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/*
  One SQLite file: settings, the projects, the tasks, steps and events of the event log, the orchestrator's
  conversations and the specialist's sandboxes. Each migration runs
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
  // A task's conversation and sandboxes, kept until it is deleted (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted).
  `
  CREATE TABLE checkpoints (
    thread_id TEXT NOT NULL,
    ns TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL,
    PRIMARY KEY (thread_id, ns, id)
  );

  CREATE TABLE checkpoint_writes (
    thread_id TEXT NOT NULL,
    ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    value BLOB NOT NULL,
    task_path TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, ns, checkpoint_id, task_id, idx)
  );

  CREATE TABLE sandboxes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    limits TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sandboxes_task ON sandboxes(task_id);
  `,
  // Projects: a target, a folder and the model its tasks run with; tasks and sandboxes belong to one
  // (adr:0020-group-tasks-into-projects-that-share-their-analyses). A sandbox now outlives the task that created it,
  // so its table is rebuilt to hang off the project; tasks from before are given projects at start.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    target_path TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    source_root TEXT NOT NULL,
    folder TEXT NOT NULL,
    owns_folder INTEGER NOT NULL DEFAULT 1,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    orchestrator_effort TEXT NOT NULL,
    specialist_effort TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX projects_created ON projects(created_at);

  ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
  CREATE INDEX tasks_project ON tasks(project_id, created_at);

  CREATE TABLE sandboxes_v3 (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    created_by TEXT,
    limits TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO sandboxes_v3 (id, project_id, created_by, limits, created_at) SELECT id, NULL, task_id, limits, created_at FROM sandboxes;
  DROP TABLE sandboxes;
  ALTER TABLE sandboxes_v3 RENAME TO sandboxes;
  CREATE INDEX sandboxes_project ON sandboxes(project_id);
  `,
  // The unknowns ledger: what a project's analyses left open, and which analysis closed it (specs/analysis-contract R2).
  `
  CREATE TABLE unknowns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    severity TEXT NOT NULL,
    probes TEXT NOT NULL DEFAULT '[]',
    settle TEXT NOT NULL DEFAULT '',
    raised_by TEXT NOT NULL,
    closed_by TEXT,
    resolution TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX unknowns_project ON unknowns(project_id, created_at);
  `,
  // Several processes on one data folder (adr:0024-share-the-data-folder-between-processes): each records itself with a
  // heartbeat, and a task records the process that opened it (specs/shared-data-folder R2.1).
  `
  CREATE TABLE processes (
    key TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    beat_at INTEGER NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN owner TEXT;
  CREATE INDEX tasks_updated ON tasks(updated_at);
  CREATE INDEX steps_updated ON steps(updated_at);
  CREATE INDEX projects_updated ON projects(updated_at);
  `,
]

/** The schema this app knows. */
export const SCHEMA_VERSION = MIGRATIONS.length

/** Which app opens the database, recorded with each migration it runs so an older app can name it (R3.3). */
export interface Opener {
  app: string
  version: string
}

/** A database migrated by a newer app than this one, refused before anything is written (specs/shared-data-folder R3.3). */
export class SchemaTooNew extends Error {
  constructor(
    readonly found: number,
    readonly by: Opener | null,
  ) {
    super(
      by
        ? `This data folder was upgraded by Harness for REA ${by.version} (${by.app === "tui" ? "the terminal UI" : "the desktop app"}); update this app to open it.`
        : `This data folder was upgraded by a newer Harness for REA (schema ${found}); update this app to open it.`,
    )
    this.name = "SchemaTooNew"
  }
}

let db: DatabaseSync | null = null

export function openDb(file: string, by: Opener = { app: "desktop", version: "" }): DatabaseSync {
  closeDb()
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const d = new DatabaseSync(file)
  // Another process may be writing: wait for it rather than fail (specs/shared-data-folder R3.1).
  d.exec("PRAGMA busy_timeout = 5000;")
  try {
    walMode(d)
    d.exec("PRAGMA foreign_keys = ON;")
    migrate(d, by)
  } catch (e) {
    d.close()
    throw e
  }
  db = d
  return d
}

/**
  Switch to WAL. On a new file two apps starting together race for it, and SQLite does not run the busy handler for a
  journal-mode change, so a locked database is retried here for as long as the busy timeout (R3.1, R3.2).
*/
function walMode(d: DatabaseSync) {
  const until = Date.now() + 5000
  for (;;) {
    try {
      d.exec("PRAGMA journal_mode = WAL;")
      return
    } catch (e) {
      if (!/locked|busy/i.test((e as Error).message) || Date.now() > until) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

const userVersion = (d: DatabaseSync) => (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version

function migratedBy(d: DatabaseSync): Opener | null {
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key = 'schema.by'").get() as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Opener) : null
  } catch {
    return null
  }
}

/**
  Bring the schema up to date, once across processes: the version is read again inside `BEGIN IMMEDIATE`, which no
  two connections hold at once, so of two apps starting together the second finds the work done (R3.2). A schema
  newer than this app knows is refused before anything is written (R3.3).
*/
export function migrate(d: DatabaseSync, by: Opener = { app: "desktop", version: "" }) {
  const check = () => {
    const v = userVersion(d)
    if (v > MIGRATIONS.length) throw new SchemaTooNew(v, migratedBy(d))
    return v
  }
  if (check() === MIGRATIONS.length) return
  d.exec("BEGIN IMMEDIATE")
  try {
    const version = check()
    for (let v = version; v < MIGRATIONS.length; v++) {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
    }
    if (version < MIGRATIONS.length)
      d.prepare("INSERT INTO settings (key, value) VALUES ('schema.by', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        JSON.stringify({ ...by, schema: MIGRATIONS.length }),
      )
    d.exec("COMMIT")
  } catch (e) {
    d.exec("ROLLBACK")
    throw e
  }
}

/** Runs `fn` in one write transaction no other process can interleave with (R4.1). */
export function exclusive<T>(fn: () => T): T {
  const d = getDb()
  d.exec("BEGIN IMMEDIATE")
  try {
    const r = fn()
    d.exec("COMMIT")
    return r
  } catch (e) {
    d.exec("ROLLBACK")
    throw e
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
