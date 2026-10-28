import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Agent, EventPayload, EventRow, PatchView, Push, StepKind, StepRow, TaskHistory, TaskRow, TaskState } from "@shared/types"
import { getDb } from "../db"
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

const LIVE: TaskState[] = ["pending", "running", "waiting"]

function taskRow(r: Row): TaskRow {
  return {
    id: String(r.id),
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

function stepRow(r: Row): StepRow {
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

function eventRow(r: Row): EventRow {
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

function patchRow(r: Row): PatchView {
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

  taskDir(taskId: string): string {
    return join(this.dataDir, "tasks", taskId)
  }

  /* ---------- tasks ---------- */

  createTask(t: { request: string; sourceRoot: string; model: string }): TaskRow {
    const id = randomUUID()
    const at = this.now()
    getDb()
      .prepare("INSERT INTO tasks (id, request, source_root, model, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, redact(t.request), t.sourceRoot, t.model, at, at)
    return this.emitTask(id)
  }

  getTask(id: string): TaskRow {
    const r = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined
    if (!r) throw new Error(`No task ${id}.`)
    return taskRow(r)
  }

  updateTask(id: string, patch: { state?: TaskState; result?: string; error?: string }): TaskRow {
    const cur = this.getTask(id)
    getDb()
      .prepare("UPDATE tasks SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(patch.state ?? cur.state, redact(patch.result ?? cur.result), redact(patch.error ?? cur.error), this.now(), id)
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

  /* ---------- history and recovery ---------- */

  history(taskId: string, o: { afterEvent?: number; limit?: number } = {}): TaskHistory {
    const limit = o.limit ?? 2000
    const rows = getDb()
      .prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(taskId, o.afterEvent ?? 0, limit + 1) as Row[]
    return {
      task: this.getTask(taskId),
      steps: this.steps(taskId),
      events: rows.slice(0, limit).map(eventRow),
      patches: (getDb().prepare("SELECT * FROM patches WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[]).map(patchRow),
      hasMore: rows.length > limit,
    }
  }

  /** At startup: every task and step left running or waiting is interrupted, and says so. Returns how many tasks. */
  recover(): number {
    const marks = LIVE.map(() => "?").join(", ")
    const tasks = (
      getDb()
        .prepare(`SELECT id FROM tasks WHERE state IN (${marks})`)
        .all(...LIVE) as Row[]
    ).map((r) => String(r.id))
    const at = this.now()
    getDb()
      .prepare(`UPDATE steps SET state = 'interrupted', updated_at = ? WHERE state IN (${marks})`)
      .run(at, ...LIVE)
    for (const id of tasks) {
      getDb().prepare("UPDATE tasks SET state = 'interrupted', updated_at = ? WHERE id = ?").run(at, id)
      this.append({
        taskId: id,
        agent: "app",
        kind: "task.interrupted",
        state: "interrupted",
        summary: "The app stopped while this task was running; retry it to start over.",
      })
      this.emitTask(id)
    }
    return tasks.length
  }
}
