---
status: accepted
---

# 0024 · Share the data folder between processes

## Context

plans/finish-the-harness 1.9 gave the data folder one lock, `hfr.lock`: the desktop app or the
terminal UI, never both, because `EventLog.recover()` marks every running task interrupted at
start and both container sweeps stop every running task container and sandbox — run under a live
app, either would wreck its tasks. plans/tui-revamp asks for the opposite: any number of TUIs,
each opened on its own folder, beside the desktop app, on one data folder. What the lock
protected has to be protected some other way, item by item:

- a task started in two apps at once, or one app's tasks recovered by another;
- the containers of another app's live tasks, stopped by a sweep;
- SQLite written by several processes: `SQLITE_BUSY`, and two apps migrating at once;
- an older app opening a database a newer one migrated;
- work that must happen once per machine, not once per app: the first-start upgrade that gives
  old tasks a project, the specialist's image build, the Claude sign-in;
- provider keys, which the desktop app encrypts with `safeStorage` into the database and the TUI
  keeps in the OS keychain through `Bun.secrets` — two stores neither app reads of the other;
- a view that only learns of a change through its own process's pushes.

adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted says starting the
app no longer removes stopped containers, and the sweeps only stop running ones; that holds.

## Decision

**The folder-wide lock goes; a lock per project replaces it.** `locks/project-<id>.lock` is
created exclusively and names the app, its pid and its start time. An app takes it when a task of
the project starts or reopens in it — a new task, a message or Continue on a closed one, a retry —
and holds it while any task of the project is open in that app, which is exactly while the
project's sandboxes are held (specs/projects R2.3); the last task to close releases it. Another
app is refused with the project's name and the app holding it. Reading, browsing and deciding on
a task's history need no lock: the desktop app lists every project and shows one held by another
app as taken by it. A lock whose process is gone is stale and taken over, as `hfr.lock` was.

**A process is identified by its pid and its start time**, recorded in a `processes` table with
the app's name and a heartbeat written every five seconds. A process is gone when its pid is not
alive, or its heartbeat is older than thirty seconds — which is what tells a reused pid from the
process that recorded it. A task records the process that opened it (`owner`).

**Recovery and both sweeps touch only what a gone process owned**, and run at the start of any
app: a task left running, waiting or stopped is interrupted only when its owner is gone; a running
task container is stopped only when its task's owner is gone; a running sandbox is stopped only
when no live process holds its project's lock.

**SQLite is shared, not guarded.** Every connection sets a five-second `busy_timeout`.
Migrations run inside `BEGIN IMMEDIATE`, reading `user_version` again inside it, so two apps
starting together migrate once. Each migration records the app and version that ran it; a
database whose `user_version` is newer than the app knows is refused, before anything is written,
naming the app and version that migrated it.

**What happens once per machine is done once.** The first-start upgrade (`ProjectStore.adopt`)
runs in one `BEGIN IMMEDIATE` transaction, so two apps on a fresh data folder produce one project
per source folder. The image build holds `locks/images.lock`: an app finding it held by a live
process reports the build as running in that app and reads the images' state again when it is
released, instead of building them a second time. The Claude sign-in holds `locks/login.lock`
while it runs, and a second app's sign-in is refused naming the app signing in. The Electron
single-instance lock stays: two desktop windows on one profile is not what this enables.

**An app learns of another process's changes by polling SQLite's `data_version`** every half
second — it changes only when another connection commits. On a change the app reads what moved
since its cursor — tasks, steps, patches and projects by `updated_at`, events by id, deletions by
absence — and pushes it to its view as if it had written it, so a view refreshes within one
second and needs no second channel. A key saved in one app bumps a `keys.rev` setting, and the
others read the keychain again.

**Provider keys live in one OS-keychain store both apps read**, through `@napi-rs/keyring`: one
generic credential per slot under the service `harness-for-rea`, its secret the key's UTF-8
bytes. It loads in Electron's Node and under Bun alike. `Bun.secrets` was the first choice for the
TUI and is not compatible: on Windows it writes a credential `@napi-rs/keyring` reads as empty,
and the desktop app cannot use it. At first start each app moves its old keys — the desktop app's
`safeStorage` settings, the TUI's `Bun.secrets` entries — into the shared store and removes them
where they were.

Rejected:

- **A lock per data folder that the TUI shares with other TUIs only.** Still one app at a time
  against the desktop app, which is the restriction being lifted.
- **A daemon owning the core, with the apps as clients.** One writer and no locks, but a third
  process to install, start, upgrade and keep alive, and a protocol between it and two views.
- **A file watcher on the database.** WAL writes land in `-wal` and `-shm`, notifications are
  unreliable across the platforms, and `data_version` answers the same question exactly.
- **Process start time read from the OS.** No portable call reaches it without spawning `ps` or
  PowerShell per check; the heartbeat answers liveness and pid reuse with one row.

## Consequences

- `hfr.lock`, `DataFolderBusy` and the TUI's "close the desktop app first" go; `tests/lock.test.ts`
  is rewritten for the per-project lock.
- A task can be read in one app while it runs in another; acting on it — a message, Continue,
  start over — is refused in the app that does not hold its project.
- Each app writes a heartbeat row every five seconds, and every app polls `data_version` twice a
  second: a cheap read that never touches the disk when nothing changed.
- An app that dies leaves its tasks running in the database until any app starts again: that
  app interrupts them and stops their containers. Live apps do not take over a dead app's tasks
  while they run.
- `@napi-rs/keyring` is a native module, the first in the stack: it ships prebuilt per platform
  as optional dependencies, needs no install script, and the TUI's binary build bundles the one
  for its target.
- A schema change now has a reader that can be older than the writer: the refusal names the newer
  app so the user knows which to update.
