import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Push } from "../src/shared/types"
import { closeDb, getDb, migrate, openDb } from "../src/main/db"
import { capPayload, EventLog, PAYLOAD_CAP } from "../src/main/events/log"
import { forgetSecrets, registerSecret } from "../src/main/events/redact"

/* specs/event-log: schema, storage, delivery, history and recovery. */

let dir = ""
let pushed: Push[] = []
let log: EventLog
let clock = 1000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hfr-events-"))
  openDb(join(dir, "hfr.db"))
  pushed = []
  clock = 1000
  log = new EventLog(
    dir,
    (p) => pushed.push(p),
    () => clock++,
  )
  forgetSecrets()
})
afterEach(() => closeDb())

describe("database (R2.1)", () => {
  it("migrates once and records the version", () => {
    expect((getDb().prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3)
    migrate(getDb())
    expect((getDb().prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3)
  })
})

describe("tasks and steps (R1.1)", () => {
  it("creates a task pending and pushes it", () => {
    const t = log.createTask({ request: "Explain the parser", sourceRoot: "C:/src", model: "m" })
    expect(t).toMatchObject({ request: "Explain the parser", state: "pending", tokensIn: 0, costUsd: 0 })
    expect(pushed).toEqual([{ type: "task", task: t }])
  })

  it("updates state and result, and adds usage to the totals", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    log.updateTask(t.id, { state: "running" })
    log.addUsage(t.id, { tokensIn: 100, tokensOut: 20, costUsd: 0.5 })
    log.addUsage(t.id, { tokensIn: 1, specialistCostUsd: 0.25 })
    const done = log.updateTask(t.id, { state: "done", result: "answer" })
    expect(done).toMatchObject({ state: "done", result: "answer", tokensIn: 101, tokensOut: 20, costUsd: 0.5, specialistCostUsd: 0.25 })
    expect(() => log.getTask("missing")).toThrow(/No task/)
  })

  it("numbers steps in order and merges their data", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    const a = log.addStep({ taskId: t.id, kind: "todo", title: "Read", agent: "orchestrator" })
    const b = log.addStep({ taskId: t.id, kind: "delegation", title: "Analyse", agent: "specialist", state: "running", data: { x: 1 } })
    expect([a.ord, b.ord]).toEqual([0, 1])
    const b2 = log.updateStep(b.id, { state: "done", data: { y: 2 } })
    expect(b2).toMatchObject({ state: "done", data: { x: 1, y: 2 } })
    expect(log.steps(t.id).map((s) => s.title)).toEqual(["Read", "Analyse"])
    expect(() => log.getStep("missing")).toThrow(/No step/)
  })
})

describe("events (R1.1–R1.3, R2.3)", () => {
  it("stores the event with its fields and pushes it", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    pushed = []
    const e = log.append({
      taskId: t.id,
      agent: "specialist",
      kind: "tool.call",
      state: "running",
      summary: "Read  src/a.ts\n",
      payload: { tool: "Read", files: [{ path: "src/a.ts", op: "read" }], tokensIn: 3 },
    })
    expect(e).toMatchObject({
      taskId: t.id,
      stepId: null,
      agent: "specialist",
      kind: "tool.call",
      state: "running",
      summary: "Read src/a.ts",
      truncated: false,
    })
    expect(e.payload.files).toEqual([{ path: "src/a.ts", op: "read" }])
    expect(pushed).toEqual([{ type: "event", event: e }])
  })

  it("redacts the summary and payload before writing", () => {
    registerSecret("sk-or-v1-thestoredkey123")
    const t = log.createTask({ request: "use sk-or-v1-thestoredkey123", sourceRoot: "s", model: "m" })
    expect(t.request).toBe("use [redacted]")
    log.append({ taskId: t.id, agent: "orchestrator", kind: "x", summary: "Bearer abc.def", payload: { output: "key sk-or-v1-thestoredkey123" } })
    const stored = JSON.stringify(getDb().prepare("SELECT * FROM events").all())
    expect(stored).not.toContain("thestoredkey")
    expect(stored).not.toContain("abc.def")
  })

  it("truncates an oversized payload and marks it", () => {
    const big = "x".repeat(PAYLOAD_CAP)
    expect(capPayload({ output: big }).truncated).toBe(true)
    expect(capPayload({ output: big }).json.length).toBeLessThanOrEqual(PAYLOAD_CAP)
    const many = { parts: Array.from({ length: 100 }, () => "y".repeat(3000)) }
    const c = capPayload(many)
    expect(c.truncated).toBe(true)
    expect(JSON.parse(c.json).excerpt).toBeTypeOf("string")
    expect(capPayload({ output: "small" })).toEqual({ json: '{"output":"small"}', truncated: false })
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    expect(log.append({ taskId: t.id, agent: "app", kind: "x", summary: "s", payload: { output: big } }).truncated).toBe(true)
  })
})

describe("raw output (R2.2)", () => {
  it("appends each raw line, redacted, to the task's own JSONL", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    log.raw(t.id, "specialist", '{"type":"assistant","x":"sk-ant-api03-abcdefghijkl"}', "step-1")
    log.raw(t.id, "specialist", "not json")
    const lines = readFileSync(join(dir, "tasks", t.id, "raw.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ agent: "specialist", step: "step-1", line: '{"type":"assistant","x":"[redacted]"}' })
    expect(lines[1].line).toBe("not json")
  })
})

describe("history (R2.4, specs/chat-timeline R2.1, R3.3)", () => {
  it("returns the task, steps, patches and the newest page of events, oldest first within it", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    log.addStep({ taskId: t.id, kind: "todo", title: "a", agent: "orchestrator" })
    for (let i = 0; i < 5; i++) log.append({ taskId: t.id, agent: "app", kind: "k", summary: `e${i}` })
    log.savePatch({ id: "00000000-0000-4000-8000-000000000001", taskId: t.id, stepId: "s", files: [], diff: "d" })
    const newest = log.history(t.id, { limit: 3 })
    expect(newest.events.map((e) => e.summary)).toEqual(["e2", "e3", "e4"])
    expect(newest).toMatchObject({ hasOlder: true, hasMore: false })
    expect(newest.steps).toHaveLength(1)
    expect(newest.patches).toHaveLength(1)
    const older = log.history(t.id, { beforeEvent: newest.events[0].id, limit: 3 })
    expect(older.events.map((e) => e.summary)).toEqual(["e0", "e1"])
    expect(older).toMatchObject({ hasOlder: false, hasMore: true })
  })

  it("pages forward after an event, saying whether older and newer events exist", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    for (let i = 0; i < 5; i++) log.append({ taskId: t.id, agent: "app", kind: "k", summary: `e${i}` })
    const all = log.history(t.id).events
    const first = log.history(t.id, { afterEvent: 0, limit: 3 })
    expect(first.events.map((e) => e.summary)).toEqual(["e0", "e1", "e2"])
    expect(first).toMatchObject({ hasMore: true, hasOlder: false })
    const next = log.history(t.id, { afterEvent: all[2].id, limit: 3 })
    expect(next.events.map((e) => e.summary)).toEqual(["e3", "e4"])
    expect(next).toMatchObject({ hasMore: false, hasOlder: true })
  })

  it("does not page into another task's events", () => {
    const a = log.createTask({ request: "a", sourceRoot: "s", model: "m" })
    const b = log.createTask({ request: "b", sourceRoot: "s", model: "m" })
    log.append({ taskId: a.id, agent: "app", kind: "k", summary: "a0" })
    const b0 = log.append({ taskId: b.id, agent: "app", kind: "k", summary: "b0" })
    log.append({ taskId: a.id, agent: "app", kind: "k", summary: "a1" })
    expect(log.history(b.id, { beforeEvent: b0.id })).toMatchObject({ events: [], hasOlder: false, hasMore: true })
    expect(log.history(b.id, { afterEvent: b0.id })).toMatchObject({ events: [], hasOlder: true, hasMore: false })
  })

  it("sums each agent's usage over the whole task, whatever page is read", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    log.append({ taskId: t.id, agent: "orchestrator", kind: "model.call", summary: "m", payload: { tokensIn: 10, tokensOut: 2, costUsd: 0.5 } })
    for (let i = 0; i < 4; i++) log.append({ taskId: t.id, agent: "app", kind: "k", summary: `e${i}` })
    log.append({
      taskId: t.id,
      agent: "specialist",
      kind: "specialist.result",
      summary: "r",
      payload: { tokensIn: 5, cacheTokens: 7, tokensOut: 3, costUsd: 1.25, estimate: true },
    })
    log.append({ taskId: t.id, agent: "orchestrator", kind: "model.call", summary: "m", payload: { tokensIn: 1, tokensOut: 1 } })
    expect(log.history(t.id, { limit: 1 }).usage).toEqual([
      { agent: "orchestrator", calls: 2, tokensIn: 11, tokensOut: 3, costUsd: 0.5, estimate: false },
      { agent: "specialist", calls: 1, tokensIn: 12, tokensOut: 3, costUsd: 1.25, estimate: true },
    ])
  })

  it("lists tasks newest first", () => {
    const a = log.createTask({ request: "a", sourceRoot: "s", model: "m" })
    const b = log.createTask({ request: "b", sourceRoot: "s", model: "m" })
    expect(log.listTasks().map((t) => t.id)).toEqual([b.id, a.id])
    expect(log.listTasks(1)).toHaveLength(1)
  })
})

describe("patches", () => {
  it("saves, updates and reports a missing one", () => {
    const t = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    const p = log.savePatch({
      id: "00000000-0000-4000-8000-000000000002",
      taskId: t.id,
      stepId: "s",
      files: [{ path: "a", status: "modified", added: 1, removed: 0 }],
      diff: "d",
    })
    expect(p.state).toBe("proposed")
    expect(log.updatePatch(p.id, { state: "conflict", conflicts: ["a"] })).toMatchObject({ state: "conflict", conflicts: ["a"] })
    expect(log.updatePatch(p.id, { state: "rejected" }).conflicts).toEqual(["a"])
    expect(() => log.getPatch("nope")).toThrow(/No patch/)
  })
})

describe("recovery (R3.1)", () => {
  it("marks live tasks and steps interrupted with an event, leaving finished ones alone", () => {
    const run = log.createTask({ request: "r", sourceRoot: "s", model: "m" })
    log.updateTask(run.id, { state: "running" })
    const wait = log.createTask({ request: "w", sourceRoot: "s", model: "m" })
    log.updateTask(wait.id, { state: "waiting" })
    const done = log.createTask({ request: "d", sourceRoot: "s", model: "m" })
    log.updateTask(done.id, { state: "done" })
    const step = log.addStep({ taskId: run.id, kind: "delegation", title: "x", agent: "specialist", state: "running" })
    expect(log.recover()).toBe(2)
    expect(log.getTask(run.id).state).toBe("interrupted")
    expect(log.getTask(wait.id).state).toBe("interrupted")
    expect(log.getTask(done.id).state).toBe("done")
    expect(log.getStep(step.id).state).toBe("interrupted")
    expect(log.history(run.id).events.at(-1)).toMatchObject({ kind: "task.interrupted", state: "interrupted" })
    expect(log.recover()).toBe(0)
  })

  it("interrupts a stopped turn and leaves a conversation that waited for the user open (specs/task-persistence R2.3)", () => {
    const stopped = log.createTask({ request: "s", sourceRoot: "s", model: "m" })
    log.updateTask(stopped.id, { state: "stopped" })
    const idle = log.createTask({ request: "i", sourceRoot: "s", model: "m" })
    log.updateTask(idle.id, { state: "awaiting-user", result: "the answer" })
    expect(log.recover()).toBe(1)
    expect(log.getTask(stopped.id).state).toBe("interrupted")
    expect(log.getTask(idle.id)).toMatchObject({ state: "awaiting-user", result: "the answer" })
    expect(log.history(idle.id).events).toHaveLength(0)
    expect(log.history(stopped.id).events.at(-1)!.summary).toMatch(/continue it to pick up where it stopped/)
  })
})
