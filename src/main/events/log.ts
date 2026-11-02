import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Agent, AgentUsage, EventPayload, EventRow, PatchView, Push, StepKind, StepRow, TaskHistory, TaskRow, TaskState } from "@shared/types"
import { getDb } from "../db"
import { removeTree } from "../sandbox/paths"
import { redact, redactValue } from "./redact"

/*
  The event log (adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task): tasks, steps, events and
  patches in SQLite, each agent's raw output in the task's own JSONL, everything redacted before it
  is written, and each change pushed to the renderer as it happens.
*/

/** Largest serialized payload kept whole. */
export const PAYLOAD_CAP = 64 * 1024
const STRING_CAP = 4000
const SUMMARY_CAP = 300
/** Longest raw line kept, so redaction stays cheap on hostile output. */
export const RAW_LINE_CAP = 256 * 1024

type Row = Record<string, unknown>

/** One delegation of a project's task, as the orchestrator reads it back (specs/projects R2.4). */
export interface ProjectAnalysis {
  id: string
  taskId: string
  state: TaskState
  objective: string
  pkg: unknown
  report: string
  evidence: number
  evidenceList: unknown[]
  error: string
  createdAt: number
}

/** A turn under way or stopped part-way: after a restart it can only be retried. */
const LIVE: TaskState[] = ["pending", "running", "waiting", "stopped"]

export function taskRow(r: Row): TaskRow {
  return {
    id: String(r.id),
    projectId: r.project_id === null || r.project_id === undefined ? null : String(r.project_id),
    request: String(r.request),
    sourceRoot: String(r.source_root),
    model: String(r.model),
    state: r.state as TaskState,
    result: String(r.result),
    error: String(r.error),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    costUsd: Number(r.cost_usd),
    specialistCostUsd: Number(r.specialist_cost_usd),
  }
}

export function stepRow(r: Row): StepRow {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    ord: Number(r.ord),
    kind: r.kind as StepKind,
    title: String(r.title),
    agent: r.agent as Agent,
    state: r.state as TaskState,
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export function eventRow(r: Row): EventRow {
  return {
    id: Number(r.id),
    taskId: String(r.task_id),
    stepId: r.step_id === null ? null : String(r.step_id),
    agent: r.agent as Agent,
    at: Number(r.at),
    kind: String(r.kind),
    state: r.state as TaskState | "",
    summary: String(r.summary),
    payload: JSON.parse(String(r.payload)) as EventPayload,
    truncated: Number(r.truncated) === 1,
  }
}

export function patchRow(r: Row): PatchView {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    stepId: String(r.step_id),
    state: r.state as PatchView["state"],
    files: JSON.parse(String(r.files)) as PatchView["files"],
    diff: String(r.diff),
    conflicts: JSON.parse(String(r.conflicts)) as string[],
    createdAt: Number(r.created_at),
  }
}

function shorten(v: unknown): unknown {
  if (typeof v === "string") return v.length > STRING_CAP ? `${v.slice(0, STRING_CAP)}…` : v
  if (Array.isArray(v)) return v.map(shorten)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]))
  return v
}

/** The payload as stored: redacted, and cut down when it exceeds the cap. */
export function capPayload(payload: EventPayload): { json: string; truncated: boolean } {
  const clean = redactValue(payload ?? {}) as EventPayload
  const json = JSON.stringify(clean)
  if (json.length <= PAYLOAD_CAP) return { json, truncated: false }
  const short = JSON.stringify(shorten(clean))
  if (short.length <= PAYLOAD_CAP) return { json: short, truncated: true }
  return { json: JSON.stringify({ excerpt: short.slice(0, PAYLOAD_CAP - 100) }), truncated: true }
}

export interface NewEvent {
  taskId: string
  stepId?: string | null
  agent: Agent
  kind: string
  state?: TaskState | ""
  summary: string
  payload?: EventPayload
}

export class EventLog {
  private readonly dataDir: string
  private push: (p: Push) => void
  private readonly now: () => number

  constructor(dataDir: string, push: (p: Push) => void = () => undefined, now: () => number = Date.now) {
    this.dataDir = dataDir
    this.push = push
    this.now = now
  }

  setPush(push: (p: Push) => void) {
    this.push = push
  }

  /** The process this log writes for, recorded on each task it opens (specs/shared-data-folder R2.1). */
  owner: string | null = null

  /** Whether this database holds the task: a container named for one it does not is another data folder's. */
  hasTask(id: string): boolean {
    return getDb().prepare("SELECT 1 FROM tasks WHERE id = ?").get(id) !== undefined
  }

  /** Records this process as the one that opened the task, before its containers come up (specs/shared-data-folder R2.1). */
  claim(id: string): void {
    if (this.owner) getDb().prepare("UPDATE tasks SET owner = ? WHERE id = ?").run(this.owner, id)
  }

  /** The process that last opened a task. */
  taskOwner(id: string): string | null {
    const r = getDb().prepare("SELECT owner FROM tasks WHERE id = ?").get(id) as Row | undefined
    return r?.owner === null || r?.owner === undefined ? null : String(r.owner)
  }

  /** A task's folder: under its project's folder (specs/projects R2.2), or the app's data folder for one without. */
  taskDir(taskId: string): string {
    const r = getDb().prepare("SELECT p.folder AS folder FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(taskId) as Row | undefined
    return join(r ? String(r.folder) : this.dataDir, "tasks", taskId)
  }

  /* ---------- tasks ---------- */

  createTask(t: { request: string; sourceRoot: string; model: string; projectId?: string | null }): TaskRow {
    const id = randomUUID()
    const at = this.now()
    getDb()
      .prepare(
        "INSERT INTO tasks (id, project_id, request, source_root, model, state, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      )
      .run(id, t.projectId ?? null, redact(t.request), t.sourceRoot, t.model, at, at, this.owner)
    return this.emitTask(id)
  }

  /** The delegations of a project's tasks, newest first: what the specialist found for it (specs/projects R2.4). */
  projectAnalyses(projectId: string): ProjectAnalysis[] {
    const rows = getDb()
      .prepare("SELECT s.* FROM steps s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.kind = 'delegation' ORDER BY s.created_at DESC")
      .all(projectId) as Row[]
    return rows.map((r) => {
      const s = stepRow(r)
      const data = s.data as { context?: { objective?: string }; report?: string; evidence?: unknown[]; error?: string }
      return {
        id: s.id,
        taskId: s.taskId,
        state: s.state,
        objective: String(data.context?.objective ?? s.title),
        pkg: data.context ?? null,
        report: String(data.report ?? ""),
        evidence: Array.isArray(data.evidence) ? data.evidence.length : 0,
        evidenceList: Array.isArray(data.evidence) ? data.evidence : [],
        error: String(data.error ?? ""),
        createdAt: s.createdAt,
      }
    })
  }

  /** The tasks of a project, newest first. */
  projectTasks(projectId: string): TaskRow[] {
    return (getDb().prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(taskRow)
  }

  getTask(id: string): TaskRow {
    const r = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined
    if (!r) throw new Error(`No task ${id}.`)
    return taskRow(r)
  }

  updateTask(id: string, patch: { state?: TaskState; result?: string; error?: string }): TaskRow {
    const cur = this.getTask(id)
    // A task set running here is this process's: recovery leaves it alone while this process lives (R2.2).
    const owner = patch.state && LIVE.includes(patch.state) && this.owner ? this.owner : this.taskOwner(id)
    getDb()
      .prepare("UPDATE tasks SET state = ?, result = ?, error = ?, updated_at = ?, owner = ? WHERE id = ?")
      .run(patch.state ?? cur.state, redact(patch.result ?? cur.result), redact(patch.error ?? cur.error), this.now(), owner, id)
    return this.emitTask(id)
  }

  /** Add one call's usage to the task's totals. */
  addUsage(id: string, u: { tokensIn?: number; tokensOut?: number; costUsd?: number; specialistCostUsd?: number }): TaskRow {
    getDb()
      .prepare(
        "UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ?, specialist_cost_usd = specialist_cost_usd + ?, updated_at = ? WHERE id = ?",
      )
      .run(u.tokensIn ?? 0, u.tokensOut ?? 0, u.costUsd ?? 0, u.specialistCostUsd ?? 0, this.now(), id)
    return this.emitTask(id)
  }

  listTasks(limit = 50): TaskRow[] {
    return (getDb().prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(taskRow)
  }

  private emitTask(id: string): TaskRow {
    const t = this.getTask(id)
    this.push({ type: "task", task: t })
    return t
  }

  /* ---------- steps ---------- */

  addStep(s: { taskId: string; kind: StepKind; title: string; agent: Agent; state?: TaskState; data?: Record<string, unknown> }): StepRow {
    const id = randomUUID()
    const at = this.now()
    const ord = (getDb().prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM steps WHERE task_id = ?").get(s.taskId) as { n: number }).n
    getDb()
      .prepare("INSERT INTO steps (id, task_id, ord, kind, title, agent, state, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, s.taskId, ord, s.kind, redact(s.title), s.agent, s.state ?? "pending", JSON.stringify(redactValue(s.data ?? {})), at, at)
    return this.emitStep(id)
  }

  getStep(id: string): StepRow {
    const r = getDb().prepare("SELECT * FROM steps WHERE id = ?").get(id) as Row | undefined
    if (!r) throw new Error(`No step ${id}.`)
    return stepRow(r)
  }

  updateStep(id: string, patch: { state?: TaskState; title?: string; data?: Record<string, unknown> }): StepRow {
    const cur = this.getStep(id)
    getDb()
      .prepare("UPDATE steps SET state = ?, title = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(patch.state ?? cur.state, redact(patch.title ?? cur.title), JSON.stringify(redactValue({ ...cur.data, ...(patch.data ?? {}) })), this.now(), id)
    return this.emitStep(id)
  }

  steps(taskId: string): StepRow[] {
    return (getDb().prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY ord").all(taskId) as Row[]).map(stepRow)
  }

  private emitStep(id: string): StepRow {
    const s = this.getStep(id)
    this.push({ type: "step", step: s })
    return s
  }

  /* ---------- events ---------- */

  append(e: NewEvent): EventRow {
    const { json, truncated } = capPayload(e.payload ?? {})
    const summary = redact(e.summary.replace(/\s+/g, " ").trim()).slice(0, SUMMARY_CAP)
    const r = getDb()
      .prepare("INSERT INTO events (task_id, step_id, agent, at, kind, state, summary, payload, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.taskId, e.stepId ?? null, e.agent, this.now(), e.kind, e.state ?? "", summary, json, truncated ? 1 : 0)
    const row = eventRow(getDb().prepare("SELECT * FROM events WHERE id = ?").get(Number(r.lastInsertRowid)) as Row)
    this.push({ type: "event", event: row })
    return row
  }

  /** One raw output line of an agent, unparsed but redacted, appended to the task's JSONL. */
  raw(taskId: string, agent: Agent, line: string, stepId?: string) {
    const dir = this.taskDir(taskId)
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, "raw.jsonl"),
      `${JSON.stringify({ at: this.now(), agent, step: stepId ?? null, line: redact(line.length > RAW_LINE_CAP ? `${line.slice(0, RAW_LINE_CAP)}…` : line) })}\n`,
      "utf8",
    )
  }

  /* ---------- patches ---------- */

  savePatch(p: Omit<PatchView, "createdAt" | "conflicts" | "state"> & { state?: PatchView["state"] }): PatchView {
    getDb()
      .prepare("INSERT INTO patches (id, task_id, step_id, state, files, diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.taskId, p.stepId, p.state ?? "proposed", JSON.stringify(p.files), redact(p.diff), this.now())
    return this.emitPatch(p.id)
  }

  getPatch(id: string): PatchView {
    const r = getDb().prepare("SELECT * FROM patches WHERE id = ?").get(id) as Row | undefined
    if (!r) throw new Error(`No patch ${id}.`)
    return patchRow(r)
  }

  updatePatch(id: string, patch: { state: PatchView["state"]; conflicts?: string[] }): PatchView {
    getDb()
      .prepare("UPDATE patches SET state = ?, conflicts = ? WHERE id = ?")
      .run(patch.state, JSON.stringify(patch.conflicts ?? this.getPatch(id).conflicts), id)
    return this.emitPatch(id)
  }

  private emitPatch(id: string): PatchView {
    const p = this.getPatch(id)
    this.push({ type: "patch", patch: p })
    return p
  }

  /**
    Remove a task's folder and its patches' stored files (specs/task-persistence R4.1); throws, keeping the task, when
    any entry cannot be removed, so nothing is reported deleted that is still on disk.
  */
  deleteTaskFiles(id: string) {
    for (const r of getDb().prepare("SELECT id FROM patches WHERE task_id = ?").all(id) as Row[]) removeTree(join(this.dataDir, "patches", String(r.id)))
    removeTree(this.taskDir(id))
  }

  /** Remove a task's records, its files already gone; its steps, events, patches and sandboxes go with the task row. */
  deleteTask(id: string) {
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id)
    this.push({ type: "taskDeleted", id })
  }

  /* ---------- history and recovery ---------- */

  /**
    A page of a task's events, oldest first within it (specs/chat-timeline R2.1): after `afterEvent`, before
    `beforeEvent`, or the newest page when neither is given. `hasMore` says newer events follow the page,
    `hasOlder` that older ones precede it. Steps, patches and usage are the whole task's (R3.3).
  */
  history(taskId: string, o: { afterEvent?: number; beforeEvent?: number; limit?: number } = {}): TaskHistory {
    const limit = o.limit ?? 2000
    const db = getDb()
    let rows: Row[]
    if (o.afterEvent !== undefined) {
      rows = db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?").all(taskId, o.afterEvent, limit + 1) as Row[]
    } else {
      const before = o.beforeEvent ?? Number.MAX_SAFE_INTEGER
      rows = (db.prepare("SELECT * FROM events WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(taskId, before, limit + 1) as Row[]).reverse()
    }
    const forward = o.afterEvent !== undefined
    const page = forward ? rows.slice(0, limit) : rows.slice(-limit)
    const exists = (sql: string, id: number) => db.prepare(`SELECT 1 FROM events WHERE task_id = ? AND ${sql} LIMIT 1`).get(taskId, id) !== undefined
    return {
      task: this.getTask(taskId),
      steps: this.steps(taskId),
      events: page.map(eventRow),
      patches: (db.prepare("SELECT * FROM patches WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[]).map(patchRow),
      hasMore: forward ? rows.length > limit : o.beforeEvent !== undefined && exists("id >= ?", o.beforeEvent),
      hasOlder: forward ? exists("id <= ?", o.afterEvent!) : rows.length > limit,
      usage: this.usage(taskId),
    }
  }

  /** Each agent's model calls, tokens and cost over the whole task, summed where they are stored (specs/chat-timeline R3.3). */
  usage(taskId: string): AgentUsage[] {
    const rows = getDb()
      .prepare(
        `SELECT agent, COUNT(*) AS calls,
           SUM(COALESCE(json_extract(payload, '$.tokensIn'), 0) + COALESCE(json_extract(payload, '$.cacheTokens'), 0)) AS tokens_in,
           SUM(COALESCE(json_extract(payload, '$.tokensOut'), 0)) AS tokens_out,
           SUM(COALESCE(json_extract(payload, '$.costUsd'), 0)) AS cost,
           MAX(COALESCE(json_extract(payload, '$.estimate'), 0)) AS estimate
         FROM events WHERE task_id = ? AND kind IN ('model.call', 'specialist.result')
         GROUP BY agent ORDER BY MIN(id)`,
      )
      .all(taskId) as Row[]
    return rows.map((r) => ({
      agent: String(r.agent),
      calls: Number(r.calls),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      costUsd: Number(r.cost),
      estimate: Number(r.estimate) === 1,
    }))
  }

  /**
    At startup: every task left running, waiting or stopped by a process that is gone, and its steps, is interrupted
    and says so; a live app's tasks are left alone (specs/shared-data-folder R2.2). A conversation that waited for
    the user stays open, to be continued from its checkpoint (specs/task-persistence R2.3). Returns how many were
    interrupted.
  */
  recover(isLive: (owner: string | null) => boolean = () => false): number {
    const marks = LIVE.map(() => "?").join(", ")
    const tasks = (
      getDb()
        .prepare(`SELECT id, owner FROM tasks WHERE state IN (${marks})`)
        .all(...LIVE) as Row[]
    )
      .filter((r) => !isLive(r.owner === null || r.owner === undefined ? null : String(r.owner)))
      .map((r) => String(r.id))
    const at = this.now()
    // A step left under way by a gone process is interrupted whatever its task's state.
    const stepTasks = (
      getDb()
        .prepare(`SELECT DISTINCT t.id AS id, t.owner AS owner FROM steps s JOIN tasks t ON t.id = s.task_id WHERE s.state IN (${marks})`)
        .all(...LIVE) as Row[]
    ).filter((r) => !isLive(r.owner === null || r.owner === undefined ? null : String(r.owner)))
    for (const r of stepTasks)
      getDb()
        .prepare(`UPDATE steps SET state = 'interrupted', updated_at = ? WHERE task_id = ? AND state IN (${marks})`)
        .run(at, String(r.id), ...LIVE)
    for (const id of tasks) {
      getDb().prepare("UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE id = ?").run(at, id)
      this.append({
        taskId: id,
        agent: "app",
        kind: "task.interrupted",
        state: "interrupted",
        summary: "The app stopped while this task was running; continue it to pick up where it stopped.",
      })
      this.emitTask(id)
    }
    return tasks.length
  }
}
