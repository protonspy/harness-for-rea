import { describe, expect, it } from "vitest"
import type { EventRow, PatchView, StepRow, TaskHistory, TaskRow } from "../src/shared/types"
import { canRetry, filesOfStep, fold, foldTasks, isLive, usageByAgent } from "../src/renderer/src/lib/store"
import { clock, diffLines, tokens, tone, usd, when } from "../src/renderer/src/lib/format"

/* specs/desktop-ui: the store that folds pushed messages, and the display helpers. */

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  request: "r",
  sourceRoot: "s",
  model: "m",
  state: "running",
  result: "",
  error: "",
  createdAt: 1,
  updatedAt: 1,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  specialistCostUsd: 0,
  ...over,
})
const step = (id: string, ord: number, over: Partial<StepRow> = {}): StepRow => ({
  id,
  taskId: "t",
  ord,
  kind: "todo",
  title: id,
  agent: "orchestrator",
  state: "pending",
  data: {},
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
const event = (id: number, over: Partial<EventRow> = {}): EventRow => ({
  id,
  taskId: "t",
  stepId: null,
  agent: "orchestrator",
  at: 1,
  kind: "k",
  state: "",
  summary: "",
  payload: {},
  truncated: false,
  ...over,
})
const patch = (id: string, createdAt: number): PatchView => ({ id, taskId: "t", stepId: "s", state: "proposed", files: [], diff: "", conflicts: [], createdAt })
const history = (): TaskHistory => ({ task: task("t"), steps: [], events: [], patches: [], hasMore: false })

describe("fold (R2.2)", () => {
  it("applies messages for the open task and ignores others", () => {
    let h = fold(history(), { type: "task", task: task("t", { state: "done" }) })
    expect(h?.task.state).toBe("done")
    expect(fold(h, { type: "task", task: task("other") })).toBe(h)
    h = fold(h, { type: "step", step: step("b", 1) })
    h = fold(h, { type: "step", step: step("a", 0) })
    h = fold(h, { type: "step", step: step("b", 1, { state: "done" }) })
    expect(h?.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["a:pending", "b:done"])
    expect(fold(h, { type: "step", step: step("x", 0, { taskId: "other" }) })).toBe(h)
    expect(fold(null, { type: "task", task: task("t") })).toBeNull()
  })

  it("appends new events once, in order", () => {
    let h = fold(history(), { type: "event", event: event(1) })
    h = fold(h, { type: "event", event: event(2) })
    h = fold(h, { type: "event", event: event(2) })
    h = fold(h, { type: "event", event: event(3, { taskId: "other" }) })
    expect(h?.events.map((e) => e.id)).toEqual([1, 2])
  })

  it("adds and updates patches", () => {
    let h = fold(history(), { type: "patch", patch: patch("p2", 2) })
    h = fold(h, { type: "patch", patch: patch("p1", 1) })
    h = fold(h, { type: "patch", patch: { ...patch("p2", 2), state: "applied" } })
    expect(h?.patches.map((p) => `${p.id}:${p.state}`)).toEqual(["p1:proposed", "p2:applied"])
    expect(fold(h, { type: "patch", patch: { ...patch("p3", 3), taskId: "other" } })).toBe(h)
    expect(fold(h, { type: "sandbox", status: { docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "x" } })).toBe(h)
  })
})

describe("foldTasks (R3.1)", () => {
  it("keeps the list newest first, replacing a task in place", () => {
    let list = foldTasks([], { type: "task", task: task("a", { createdAt: 1 }) })
    list = foldTasks(list, { type: "task", task: task("b", { createdAt: 2 }) })
    list = foldTasks(list, { type: "task", task: task("a", { createdAt: 1, state: "done" }) })
    expect(list.map((t) => `${t.id}:${t.state}`)).toEqual(["b:running", "a:done"])
    expect(foldTasks(list, { type: "event", event: event(1) })).toBe(list)
  })
})

describe("usage and files (R2.3, R2.5)", () => {
  it("sums tokens and cost per agent, marking the specialist's as an estimate", () => {
    const u = usageByAgent([
      event(1, { kind: "model.call", payload: { tokensIn: 100, tokensOut: 10, costUsd: 0.01 } }),
      event(2, { kind: "model.call", payload: { tokensIn: 50, tokensOut: 5, costUsd: 0.02 } }),
      event(3, { kind: "specialist.result", agent: "specialist", payload: { tokensIn: 1000, cacheTokens: 200, tokensOut: 300, costUsd: 0.4, estimate: true } }),
      event(4, { kind: "tool.call", payload: { tokensIn: 999 } }),
    ])
    expect(u).toEqual([
      { agent: "orchestrator", calls: 2, tokensIn: 150, tokensOut: 15, costUsd: 0.03, estimate: false },
      { agent: "specialist", calls: 1, tokensIn: 1200, tokensOut: 300, costUsd: 0.4, estimate: true },
    ])
  })

  it("collects the files a delegation touched, by operation, once each", () => {
    const f = filesOfStep(
      [
        event(1, {
          stepId: "s",
          payload: {
            files: [
              { path: "a", op: "copy" },
              { path: "b", op: "copy" },
            ],
          },
        }),
        event(2, { stepId: "s", payload: { files: [{ path: "a", op: "read" }] } }),
        event(3, {
          stepId: "s",
          payload: {
            files: [
              { path: "a", op: "read" },
              { path: "a", op: "write" },
            ],
          },
        }),
        event(4, { stepId: "other", payload: { files: [{ path: "z", op: "read" }] } }),
        event(5, { stepId: "s", payload: { files: [{ path: "a", op: "apply" }] } }),
      ],
      "s",
    )
    expect(f).toEqual({ copy: ["a", "b"], read: ["a"], write: ["a"], apply: ["a"] })
  })

  it("knows which states are live and which can be retried (R2.6, R3.1)", () => {
    expect(isLive("waiting")).toBe(true)
    expect(isLive("done")).toBe(false)
    expect(canRetry("interrupted")).toBe(true)
    expect(canRetry("running")).toBe(false)
  })
})

describe("format", () => {
  it("formats money, tokens and relative time", () => {
    expect(usd(0)).toBe("$0.00")
    expect(usd(0.0042)).toBe("$0.0042")
    expect(usd(1.5)).toBe("$1.50")
    expect(tokens(950)).toBe("950")
    expect(tokens(1234)).toBe("1.2k")
    expect(tokens(45_000)).toBe("45k")
    expect(tokens(2_500_000)).toBe("2.5M")
    expect(when(1000, 1000 + 5_000)).toBe("just now")
    expect(when(0, 5 * 60_000)).toBe("5 min ago")
    expect(when(0, 3 * 3_600_000)).toBe("3 h ago")
    expect(when(0, 3 * 86_400_000)).toBe(new Date(0).toLocaleDateString())
    expect(clock(0)).toBeTypeOf("string")
  })

  it("gives each state a tone", () => {
    expect([tone("running"), tone("waiting"), tone("done"), tone("failed"), tone("interrupted"), tone("cancelled"), tone("")]).toEqual([
      "info",
      "warn",
      "ok",
      "bad",
      "bad",
      "neutral",
      "neutral",
    ])
  })

  it("classifies diff lines", () => {
    expect(diffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same").map((l) => l.kind)).toEqual(["file", "file", "hunk", "del", "add", "ctx"])
  })
})
