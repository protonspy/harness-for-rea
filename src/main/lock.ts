import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/*
  One app on a data folder at a time (plans/finish-the-harness 1.9): the desktop app and the TUI each take
  `hfr.lock` at start, before the database opens, so the second one names the app that holds it and exits — and
  `log.recover()`, which marks every running task interrupted, never runs under a live task of the other app.
*/

export type AppName = "desktop" | "tui"

const LABEL: Record<AppName, string> = { desktop: "the desktop app", tui: "the terminal UI" }

export const LOCK_FILE = "hfr.lock"

interface Holder {
  app: AppName
  pid: number
  since: number
}

export class DataFolderBusy extends Error {
  constructor(readonly holder: Holder) {
    super(`Harness for REA is already open in ${LABEL[holder.app]} (process ${holder.pid}) on this data folder. Close it first.`)
    this.name = "DataFolderBusy"
  }
}

/** Whether a process is alive: signal 0 checks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function read(file: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Partial<Holder>
    return (h.app === "desktop" || h.app === "tui") && Number.isInteger(h.pid) ? (h as Holder) : null
  } catch {
    return null
  }
}

/**
  Take the data folder's lock for `app`, or throw `DataFolderBusy` naming the app that holds it. A lock whose
  process is gone, or that cannot be read, is stale and taken over. Returns the release, which leaves a lock
  another process took alone.
*/
export function lockDataFolder(dataDir: string, app: AppName, pid = process.pid, isAlive: (pid: number) => boolean = alive): () => void {
  const file = join(dataDir, LOCK_FILE)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      // Created exclusively: of two apps starting at once, one wins.
      const fd = openSync(file, "wx")
      writeSync(fd, JSON.stringify({ app, pid, since: Date.now() } satisfies Holder))
      closeSync(fd)
      return () => {
        if (read(file)?.pid === pid) rmSync(file, { force: true })
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      const holder = read(file)
      if (holder && holder.pid !== pid && isAlive(holder.pid)) throw new DataFolderBusy(holder)
      // An unreadable lock may be one another app is writing this instant: only an old one is stale.
      if (!holder && ageOf(file) < UNREADABLE_STALE_MS) {
        pause()
        continue
      }
      // One process at a time clears a stale lock, and only the one it read: none removes a lock another just took.
      if (!guarded(file, () => sameHolder(read(file), holder) && rmSync(file, { force: true }))) pause()
    }
  }
  throw new Error(`Could not take the lock on ${dataDir}; another app may be starting on it.`)
}

/** About a second of retries, well inside the window an unreadable lock is taken to be still written. */
const ATTEMPTS = 20
const PAUSE_MS = 50
/** An unreadable lock this recent may still be being written. */
const UNREADABLE_STALE_MS = 5000
/** A takeover guard this old was left by a process that died holding it. */
const GUARD_STALE_MS = 10_000

function pause() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS)
}

function ageOf(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}

function sameHolder(a: Holder | null, b: Holder | null): boolean {
  return a === null || b === null ? a === b : a.pid === b.pid && a.since === b.since
}

/** Runs `clear` holding `<lock>.takeover`, created exclusively; false when another process holds it. */
function guarded(file: string, clear: () => unknown): boolean {
  const guard = `${file}.takeover`
  try {
    closeSync(openSync(guard, "wx"))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    if (ageOf(guard) > GUARD_STALE_MS) rmSync(guard, { force: true })
    return false
  }
  try {
    clear()
  } finally {
    rmSync(guard, { force: true })
  }
  return true
}

/** Where the desktop app keeps its data — Electron's `userData` for the product name — so the TUI opens the same folder. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const name = "Harness for REA"
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), name)
  if (platform === "darwin") return join(home, "Library", "Application Support", name)
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), name)
}
