import type { DatabaseSync } from "node:sqlite"
import type { EventRow, PatchView, ProjectRow, Push, StepRow, TaskRow } from "@shared/types"
import { getDb } from "./db"

/*
  How an app sees what another process changed (specs/shared-data-folder R5.3,
  adr:0024-share-the-data-folder-between-processes): SQLite's `data_version` changes only when another connection
  commits, so polling it twice a second is free while nothing happens. On a change, what moved since the last look —
  events by id, tasks, steps and projects by `updated_at`, patches by state, deletions by absence — is pushed to the
  view as if this process had written it. A change of which app holds a project, which lives in a lock file, is
  checked on the same tick.
*/

type Row = Record<string, unknown>

export interface WatchSources {
  push(p: Push): void
  task(id: string): TaskRow
  step(row: Row): StepRow
  event(row: Row): EventRow
  patch(row: Row): PatchView
  /** a project as the view sees it, with the app holding it */
  project(id: string): ProjectRow
  /** which project each live app other than this one holds, as a comparable signature */
  holders(): string
  /** called when another app saved or removed a provider key */
  keysChanged(): void
}

/** How far back a row's `updated_at` is looked at again: rows another process committed late, with an older stamp. */
const SLACK_MS = 5000

export class ChangeWatcher {
  private version = -1
  private maxEvent = 0
  private cursor = 0
  private readonly tasks = new Map<string, number>()
  private readonly steps = new Map<string, number>()
  private readonly projects = new Map<string, number>()
  private readonly patches = new Map<string, string>()
  private keysRev = ""
  private holders = ""
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly src: WatchSources,
    private readonly intervalMs = 500,
  ) {}

  private db(): DatabaseSync {
    return getDb()
  }

  private dataVersion(): number {
    return Number((this.db().prepare("PRAGMA data_version").get() as { data_version: number }).data_version)
  }

  private rev(): string {
    const r = this.db().prepare("SELECT value FROM settings WHERE key = 'keys.rev'").get() as { value: string } | undefined
    return r?.value ?? ""
  }

  /** Take the database as it is now as seen, and start polling. */
  start(): void {
    const d = this.db()
    this.version = this.dataVersion()
    this.maxEvent = Number((d.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as Row).m)
    for (const r of d.prepare("SELECT id, updated_at FROM tasks").all() as Row[]) this.tasks.set(String(r.id), Number(r.updated_at))
    for (const r of d.prepare("SELECT id, updated_at FROM projects").all() as Row[]) this.projects.set(String(r.id), Number(r.updated_at))
    for (const r of d.prepare("SELECT id, state FROM patches").all() as Row[]) this.patches.set(String(r.id), String(r.state))
    this.cursor = Math.max(0, ...this.tasks.values(), ...this.projects.values())
    for (const r of d.prepare("SELECT id, updated_at FROM steps WHERE updated_at >= ?").all(this.cursor - SLACK_MS) as Row[])
      this.steps.set(String(r.id), Number(r.updated_at))
    this.keysRev = this.rev()
    this.holders = this.src.holders()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** What this process pushed itself, so it is not pushed again. */
  saw(p: Push): void {
    if (p.type === "event") this.maxEvent = Math.max(this.maxEvent, p.event.id)
    else if (p.type === "task") this.tasks.set(p.task.id, p.task.updatedAt)
    else if (p.type === "step") this.steps.set(p.step.id, p.step.updatedAt)
    else if (p.type === "project") this.projects.set(p.project.id, p.project.updatedAt)
    else if (p.type === "patch") this.patches.set(p.patch.id, p.patch.state)
    else if (p.type === "taskDeleted") this.tasks.delete(p.id)
    else if (p.type === "projectDeleted") this.projects.delete(p.id)
  }

  /** One look: the lock files, then the database when another connection committed. Returns how much it pushed. */
  tick(): number {
    let pushed = 0
    try {
      const holders = this.src.holders()
      if (holders !== this.holders) {
        this.holders = holders
        for (const id of this.projects.keys()) pushed += this.emit({ type: "project", project: this.src.project(id) })
      }
      const v = this.dataVersion()
      if (v === this.version) return pushed
      // Taken as seen only once the diff went through: one that failed part-way is read again at the next tick.
      pushed += this.diff()
      this.version = v
      return pushed
    } catch {
      // The database closed under the timer at shutdown, or a row went between two reads: the next tick looks again.
      return pushed
    }
  }

  private emit(p: Push): number {
    this.saw(p)
    this.src.push(p)
    return 1
  }

  private diff(): number {
    const d = this.db()
    let n = 0
    const since = this.cursor - SLACK_MS
    const touched = new Set<string>()

    for (const r of d.prepare("SELECT * FROM projects WHERE updated_at >= ?").all(since) as Row[]) {
      const id = String(r.id)
      this.cursor = Math.max(this.cursor, Number(r.updated_at))
      if (this.projects.get(id) !== Number(r.updated_at)) n += this.emit({ type: "project", project: this.src.project(id) })
    }
    const projectIds = new Set((d.prepare("SELECT id FROM projects").all() as Row[]).map((r) => String(r.id)))
    for (const id of [...this.projects.keys()]) if (!projectIds.has(id)) n += this.emit({ type: "projectDeleted", id })

    for (const r of d.prepare("SELECT id, updated_at FROM tasks WHERE updated_at >= ?").all(since) as Row[]) {
      const id = String(r.id)
      this.cursor = Math.max(this.cursor, Number(r.updated_at))
      if (this.tasks.get(id) !== Number(r.updated_at)) {
        touched.add(id)
        n += this.emit({ type: "task", task: this.src.task(id) })
      }
    }
    const taskIds = new Set((d.prepare("SELECT id FROM tasks").all() as Row[]).map((r) => String(r.id)))
    for (const id of [...this.tasks.keys()]) if (!taskIds.has(id)) n += this.emit({ type: "taskDeleted", id })

    for (const r of d.prepare("SELECT * FROM steps WHERE updated_at >= ?").all(since) as Row[]) {
      if (this.steps.get(String(r.id)) === Number(r.updated_at)) continue
      touched.add(String(r.task_id))
      n += this.emit({ type: "step", step: this.src.step(r) })
    }

    for (const r of d.prepare("SELECT * FROM events WHERE id > ? ORDER BY id").all(this.maxEvent) as Row[]) {
      touched.add(String(r.task_id))
      n += this.emit({ type: "event", event: this.src.event(r) })
    }

    for (const taskId of touched)
      for (const r of d.prepare("SELECT * FROM patches WHERE task_id = ?").all(taskId) as Row[])
        if (this.patches.get(String(r.id)) !== String(r.state)) n += this.emit({ type: "patch", patch: this.src.patch(r) })

    const rev = this.rev()
    if (rev !== this.keysRev) {
      this.keysRev = rev
      this.src.keysChanged()
    }
    return n
  }
}
