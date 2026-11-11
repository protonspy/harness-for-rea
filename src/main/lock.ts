import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/*
  Locks under the data folder's `locks/`, shared by every app on it (adr:0024-share-the-data-folder-between-processes):
  one per project, held while a task of it is open in an app (specs/shared-data-folder R1), and one per job that is
  done once per machine — the image build and the Claude sign-in (R4.2, R4.3). Each is a file created exclusively,
  naming the app and the process that holds it; one whose process is gone is stale and taken over (R1.4).
*/

export type AppName = "desktop" | "tui"

export const APP_LABEL: Record<AppName, string> = { desktop: "the desktop app", tui: "a terminal UI" }

/** Who holds a lock: the app, its pid and its start time, which together name one process (R2.1). */
export interface Holder {
  app: AppName
  pid: number
  /** the process's start time, telling a reused pid from the process that took the lock */
  since: number
}

/** A lock another live process holds. */
export class LockHeld extends Error {
  constructor(
    readonly holder: Holder,
    message: string,
  ) {
    super(message)
    this.name = "LockHeld"
  }
}

export const LOCKS_DIR = "locks"

export const projectLockName = (projectId: string) => `project-${projectId}`
export const slotLockName = (slot: string) => `keyring-${slot.replace(/[^a-zA-Z0-9_-]/g, "_")}`

/** Default identity for the current process taking a lock. */
export function defaultHolder(
  app: AppName = typeof process !== "undefined" && (process.versions as unknown as Record<string, string>)?.electron ? "desktop" : "tui",
): Holder {
  const uptimeMs = typeof process !== "undefined" && typeof process.uptime === "function" ? process.uptime() * 1000 : 0
  return {
    app,
    pid: typeof process !== "undefined" ? process.pid : 1,
    since: Math.round(Date.now() - uptimeMs),
  }
}

function read(file: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Partial<Holder>
    return (h.app === "desktop" || h.app === "tui") && Number.isInteger(h.pid) && typeof h.since === "number" ? (h as Holder) : null
  } catch {
    return null
  }
}

export const sameProcess = (a: Holder | null, b: Holder | null) => (a === null || b === null ? a === b : a.pid === b.pid && a.since === b.since)

/** The locks of one data folder, taken as one process. */
export class Locks {
  readonly dir: string

  constructor(
    dataDir: string,
    readonly me: Holder,
    /** whether the process a lock names is still running (R1.4) */
    private readonly isLive: (h: Holder) => boolean = (h) => pidAlive(h.pid),
  ) {
    this.dir = dataDir.endsWith(LOCKS_DIR) || dataDir.endsWith(`${LOCKS_DIR}/`) || dataDir.endsWith(`${LOCKS_DIR}\\`) ? dataDir : join(dataDir, LOCKS_DIR)
    mkdirSync(this.dir, { recursive: true })
  }

  private file(name: string) {
    return join(this.dir, `${name}.lock`)
  }

  /** The live process holding `name`, other than this one; null when free, stale or held by this process. */
  holder(name: string): Holder | null {
    const h = read(this.file(name))
    return h && !sameProcess(h, this.me) && this.isLive(h) ? h : null
  }

  /** Every lock a live process other than this one holds, by name. */
  held(): Map<string, Holder> {
    const out = new Map<string, Holder>()
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return out
    }
    for (const f of names) {
      if (!f.endsWith(".lock")) continue
      const name = f.slice(0, -".lock".length)
      const h = this.holder(name)
      if (h) out.set(name, h)
    }
    return out
  }

  /**
    Take `name` for this process, or throw `LockHeld` with `busy(holder)` when another live process holds it. A lock
    this process already holds is taken again. Returns the release, which leaves a lock another process took alone.
  */
  take(name: string, busy: (h: Holder) => string): () => void {
    const file = this.file(name)
    const release = () => {
      if (sameProcess(read(file), this.me)) rmSync(file, { force: true })
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        // Created exclusively: of two processes taking it at once, one wins.
        const fd = openSync(file, "wx")
        writeSync(fd, JSON.stringify(this.me))
        closeSync(fd)
        return release
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        const h = read(file)
        if (h && sameProcess(h, this.me)) return release
        if (h && this.isLive(h)) throw new LockHeld(h, busy(h))
        // An unreadable lock may be one another process is writing this instant: only an old one is stale.
        if (!h && ageOf(file) < UNREADABLE_STALE_MS) {
          pause()
          continue
        }
        // One process at a time clears a stale lock, and only the one it read: none removes a lock another just took.
        if (!guarded(file, () => sameProcess(read(file), h) && rmSync(file, { force: true }))) pause()
      }
    }
    throw new Error(`Could not take the lock ${name}; another app may be taking it.`)
  }

  /**
    Asynchronously takes `name` for this process, waiting while another live process holds it up to `timeoutMs`.
    Throws `LockHeld` when another live process still holds it when the timeout expires.
    Returns the release function, which only removes the lock if this process still holds it.
  */
  async acquire(name: string, timeoutMs = 5000, pollIntervalMs = 25): Promise<() => void> {
    const file = this.file(name)
    const release = () => {
      if (sameProcess(read(file), this.me)) rmSync(file, { force: true })
    }
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      try {
        const fd = openSync(file, "wx")
        writeSync(fd, JSON.stringify(this.me))
        closeSync(fd)
        return release
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        const h = read(file)
        if (h && sameProcess(h, this.me)) return release
        if (h && this.isLive(h)) {
          await new Promise((r) => setTimeout(r, pollIntervalMs))
          continue
        }
        if (!h && ageOf(file) < UNREADABLE_STALE_MS) {
          await new Promise((r) => setTimeout(r, pollIntervalMs))
          continue
        }
        if (guarded(file, () => sameProcess(read(file), h) && rmSync(file, { force: true }))) {
          continue
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs))
      }
    }

    const h = read(file)
    if (h && this.isLive(h)) {
      throw new LockHeld(h, `Lock ${name} is held by ${APP_LABEL[h.app]} (process ${h.pid}).`)
    }
    throw new Error(`Could not take the lock ${name}; timed out after ${timeoutMs}ms.`)
  }
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

/** Whether a process is alive: signal 0 checks without sending anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Where the desktop app keeps its data — Electron's `userData` for the product name — so the TUI opens the same folder. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const name = "Harness for REA"
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), name)
  if (platform === "darwin") return join(home, "Library", "Application Support", name)
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), name)
}
