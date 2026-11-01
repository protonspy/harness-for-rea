import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
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
  for (let attempt = 0; attempt < 3; attempt++) {
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
      rmSync(file, { force: true })
    }
  }
  throw new Error(`Could not take the lock on ${dataDir}.`)
}

/** Where the desktop app keeps its data — Electron's `userData` for the product name — so the TUI opens the same folder. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const name = "Harness for REA"
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), name)
  if (platform === "darwin") return join(home, "Library", "Application Support", name)
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), name)
}
