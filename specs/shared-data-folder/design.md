# Shared data folder — design

## What changes

Serves R1–R5 under adr:0024-share-the-data-folder-between-processes, which records why a lock per
project, a heartbeat per process, polling `data_version` and `@napi-rs/keyring` won over a daemon,
a file watcher and `Bun.secrets`.

- `src/main/lock.ts` — `hfr.lock` and `DataFolderBusy` go. `Locks` takes and releases named locks
  under `<data>/locks/`, each a file created exclusively that names the app, its pid and its start
  time; a lock whose process is gone is taken over (R1.4). Names: `project-<id>` (R1), `images`
  (R4.2), `login` (R4.3).
- `src/main/processes.ts` (new) — `ProcessRegistry`: this process's row in `processes`, its
  heartbeat every five seconds, and `isLive(key)` for any process key `pid:start` (R2.1).
- `src/main/db.ts` — migration 5: the `processes` table, `tasks.owner`, and indexes on `updated_at`
  for the watcher. `busy_timeout = 5000` on every connection (R3.1), WAL switched with retries,
  migrations inside `BEGIN IMMEDIATE` with the version read again inside it (R3.2), `schema.by`
  recorded and `SchemaTooNew` thrown for a newer schema before anything is written (R3.3).
  `exclusive()` runs the first-start upgrade in one write transaction (R4.1).
- `src/main/events/log.ts` — a task records `owner`, the process that created or set it running;
  `recover(isLive)` interrupts only tasks and steps of a gone process (R2.2).
- `src/main/sandbox/taskbox.ts`, `specialistbox.ts` — each `sweep` lists running containers by name
  and stops only those a predicate does not keep: a task owned by a live process, a sandbox of a
  project a live app holds (R2.3).
- `src/main/status.ts` — `SandboxService` and `LoginService` take a `OnceGuard`. A build held
  elsewhere shows as building in that app and polls until the guard is free, then reads the images
  again (R4.2); a sign-in held elsewhere is refused naming the app (R4.3).
- `src/main/keys.ts` (new) — `keyringStore()`, the shared key store on `@napi-rs/keyring`: one
  credential per slot under the service `harness-for-rea`, the secret the key's UTF-8 bytes (R5.1).
  `credentials.ts` gains `moveKeys(from, to)` (R5.2). `keys-electron.ts` and `tui/src/keys.ts`
  become the former stores read once and emptied.
- `src/main/watch.ts` (new) — `ChangeWatcher`: every 500 ms it compares `PRAGMA data_version`, and
  on a change pushes what moved since its cursor; it also compares which app holds which project,
  from the lock files, and pushes those projects (R1.3, R5.3). A bump of `keys.rev`, written by
  `saveKey` and `clearKey`, reloads the keys (R5.1).
- `src/main/core.ts` — the wiring: the registry, the locks, the moved keys, the scoped recovery and
  sweeps, the guarded upgrade, a project's lock claimed by a task's workspace and released when the
  project's last open task here disposes (R1.1), every task-changing handler refused with
  `ProjectBusy` while another live app holds the project (R1.2), projects listed with `heldBy`
  (R1.3), and the watcher. `CoreHost` gains `version` and `formerKeys`.
- `src/main/index.ts` — the Electron single-instance lock stays (R4.4); a `SchemaTooNew` is shown in
  a dialog.
- `src/shared/types.ts` — `ProjectRow.heldBy`.
- `src/renderer/src/` — `heldLabel` in `lib/projects.ts`; the sidebar marks a held project with a
  lock, and the project view says which app holds it and disables Start and Delete (R1.3).

## When an app takes a project

The lock is claimed where a task gets its workspace in this process — the one place every start,
reopen and retry passes — and refcounted per project, so it is held exactly while the project's
sandboxes are (specs/projects R2.3). The handlers check it first so a refusal arrives before a
task row is written; a race between two apps past that check fails the later task's workspace with
the same message.

## Data

```
processes(key PRIMARY KEY = "<pid>:<start>", app, pid, started_at, version, beat_at)
tasks.owner           the process key that opened the task, or NULL for one from before
settings 'schema.by'  {app, version, schema} of the migration that last ran
settings 'keys.rev'   bumped when a key is saved or removed
<data>/locks/<name>.lock   {app, pid, since}
```
