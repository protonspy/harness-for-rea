import { getDb } from "./db"
import { pidAlive, type AppName, type Holder } from "./lock"

/*
  The processes running on a data folder (specs/shared-data-folder R2.1, adr:0024-share-the-data-folder-between-processes):
  each app records itself — its app, pid and start time — and writes a heartbeat while it runs. A process is gone
  when its pid is not alive or its heartbeat is stale; the stale heartbeat is what tells a reused pid apart.
*/

export const BEAT_MS = 5000
export const STALE_MS = 30_000

/** A process's key in the database: its pid and its start time. */
export const processKey = (h: Pick<Holder, "pid" | "since">) => `${h.pid}:${h.since}`

export class ProcessRegistry {
  readonly me: Holder
  readonly key: string
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    app: AppName,
    private readonly version: string,
    private readonly now: () => number = Date.now,
    private readonly alive: (pid: number) => boolean = pidAlive,
    pid = process.pid,
    since = Math.round(now() - process.uptime() * 1000),
  ) {
    this.me = { app, pid, since }
    this.key = processKey(this.me)
  }

  /** Record this process and keep its heartbeat until `stop`. */
  start(): void {
    getDb()
      .prepare(
        `INSERT INTO processes (key, app, pid, started_at, version, beat_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET beat_at = excluded.beat_at`,
      )
      .run(this.key, this.me.app, this.me.pid, this.me.since, this.version, this.now())
    this.timer = setInterval(() => this.beat(), BEAT_MS)
    this.timer.unref?.()
  }

  beat(): void {
    try {
      getDb().prepare("UPDATE processes SET beat_at = ? WHERE key = ?").run(this.now(), this.key)
    } catch {
      // The database closed under the timer at shutdown.
    }
  }

  /** Forget this process: its row goes, and with it any claim on what it owned. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      getDb().prepare("DELETE FROM processes WHERE key = ?").run(this.key)
    } catch {
      // already closed
    }
  }

  /** Whether the process with this key is running: this one, or one whose pid lives and whose heartbeat is fresh (R2.1). */
  isLive(key: string | null): boolean {
    if (!key) return false
    if (key === this.key) return true
    const row = getDb().prepare("SELECT pid, beat_at FROM processes WHERE key = ?").get(key) as { pid: number; beat_at: number } | undefined
    return !!row && this.now() - Number(row.beat_at) < STALE_MS && this.alive(Number(row.pid))
  }

  /** The same, for the process a lock names. */
  holds = (h: Holder): boolean => this.isLive(processKey(h))

  /** Drop the rows of processes that are gone, so the table stays the live ones. */
  prune(): void {
    const rows = getDb().prepare("SELECT key FROM processes").all() as { key: string }[]
    for (const { key } of rows) if (!this.isLive(key)) getDb().prepare("DELETE FROM processes WHERE key = ?").run(key)
  }
}
