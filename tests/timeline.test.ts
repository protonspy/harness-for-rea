import { describe, expect, it } from "vitest"
import type { EventRow, StepRow } from "@shared/types"
import type { ToolItem } from "../src/renderer/src/lib/chat"
import { stepOf, Timeline } from "../src/renderer/src/lib/timeline"

/* specs/chat-timeline R1.1, R1.3, R2.3, R3.2: the timeline folded from pages of the log. */

let n = 0
const ev = (kind: string, payload: Record<string, unknown> = {}, o: Partial<EventRow> = {}): EventRow => ({
  id: ++n,
  taskId: "t",
  stepId: null,
  agent: "orchestrator",
  at: n,
  kind,
  state: "",
  summary: kind,
  payload,
  truncated: false,
  ...o,
})
const step = (id: string, data: Record<string, unknown> = {}): StepRow => ({
  id,
  taskId: "t",
  ord: 1,
  kind: "delegation",
  title: id,
  agent: "specialist",
  state: "running",
  data,
  createdAt: 0,
  updatedAt: 0,
})

describe("the timeline (specs/chat-timeline)", () => {
  it("nests the specialist's text, thinking and tool calls under the delegation that ran them, results paired by call id", () => {
    const steps = [step("s1", { callId: "call-1" })]
    const t = new Timeline(
      steps,
      [
        ev("message.user", { output: "go" }, { agent: "app" }),
        ev("tool.call", { tool: "delegate_to_specialist", input: "{}", callId: "call-1" }),
        ev("sandbox.copy", { output: "" }, { agent: "sandbox", stepId: "s1", summary: "Copied 1 file(s)" }),
        ev("specialist.thinking", { output: "hmm" }, { agent: "specialist", stepId: "s1" }),
        ev("specialist.tool.call", { tool: "Read", callId: "r1", input: '{"file_path":"/work/a"}' }, { agent: "specialist", stepId: "s1", summary: "Read a" }),
        ev("specialist.text", { output: "found it" }, { agent: "specialist", stepId: "s1" }),
        ev("specialist.tool.result", { tool: "Read", callId: "r1", output: "contents" }, { agent: "specialist", stepId: "s1" }),
        ev("tool.result", { tool: "delegate_to_specialist", output: "{}", callId: "call-1" }),
      ],
      true,
    )
    expect(t.items.map((i) => i.kind)).toEqual(["user", "tool"])
    const call = t.items[1] as ToolItem
    expect(call).toMatchObject({ callId: "call-1", output: "{}" })
    expect(stepOf(call, steps)?.id).toBe("s1")
    expect(t.run("s1").map((e) => `${e.kind}:${e.output ?? e.body}`)).toEqual(["note:", "thinking:hmm", "tool:contents", "text:found it"])
  })

  it("shows how long a running specialist tool has run from its heartbeats, without an entry of their own (R1.4)", () => {
    const t = new Timeline(
      [step("s1")],
      [
        ev("specialist.tool.call", { tool: "Bash", callId: "b1", input: "{}" }, { agent: "specialist", stepId: "s1" }),
        ev("specialist.tool.progress", { tool: "Bash", callId: "b1", elapsedSeconds: 30 }, { agent: "specialist", stepId: "s1" }),
      ],
      true,
    )
    expect(t.run("s1")).toHaveLength(1)
    expect(t.run("s1")[0]).toMatchObject({ kind: "tool", elapsedSeconds: 30 })
    t.append([ev("specialist.tool.result", { tool: "Bash", callId: "b1", output: "done" }, { agent: "specialist", stepId: "s1" })])
    t.append([ev("specialist.tool.progress", { tool: "Bash", callId: "b1", elapsedSeconds: 45 }, { agent: "specialist", stepId: "s1" })])
    expect(t.run("s1")[0]).toMatchObject({ output: "done", elapsedSeconds: 30 })
  })

  it("folds only events newer than the last one, adding a specialist's event under its delegation as it arrives", () => {
    const steps = [step("s1", { callId: "c" })]
    const first = [ev("tool.call", { tool: "delegate_to_specialist", callId: "c" })]
    const t = new Timeline(steps, first, true)
    const items = t.items
    expect(t.append(first)).toBe(false)
    const text = ev("specialist.text", { output: "x" }, { agent: "specialist", stepId: "s1" })
    expect(t.append([text])).toBe(true)
    expect(t.append([text])).toBe(false)
    expect(t.items).toBe(items)
    expect(t.run("s1")).toHaveLength(1)
    expect(t.events).toHaveLength(2)
  })

  it("pairs a result with its call by id even when two calls of one tool overlap", () => {
    const t = new Timeline(
      [],
      [
        ev("tool.call", { tool: "execute", callId: "a" }),
        ev("tool.call", { tool: "execute", callId: "b" }),
        ev("tool.result", { tool: "execute", callId: "b", output: "B" }),
        ev("tool.result", { tool: "execute", callId: "a", output: "ERROR: A" }),
      ],
      true,
    )
    expect(t.items.map((i) => `${(i as ToolItem).callId}:${(i as ToolItem).output}:${(i as ToolItem).failed}`)).toEqual(["a:ERROR: A:true", "b:B:false"])
  })

  it("refolds from an older page with what was loaded after it, and knows no opening request on a page that starts mid-task", () => {
    const older = [ev("message.user", { output: "first" }, { agent: "app" }), ev("tool.call", { tool: "ls", callId: "l" })]
    const newer = [ev("message.user", { output: "later" }, { agent: "app" }), ev("tool.result", { tool: "ls", callId: "l", output: "x" })]
    const page = new Timeline([], newer, false)
    expect(page.items).toEqual([expect.objectContaining({ kind: "user", text: "later", read: false })])
    const whole = page.prepend(older, [], true)
    expect(whole.firstId).toBe(older[0].id)
    expect(whole.items.map((i) => i.kind)).toEqual(["user", "tool", "user"])
    expect(whole.items[0]).toMatchObject({ read: true })
    expect(whole.items[1]).toMatchObject({ output: "x" })
  })

  it("marks a failed delegation event and leaves a question in the conversation rather than in the run", () => {
    const t = new Timeline(
      [step("s1")],
      [
        ev("delegation.failed", { error: "boom" }, { agent: "sandbox", stepId: "s1" }),
        ev("specialist.result", { output: "r", error: "x" }, { agent: "specialist", stepId: "s1" }),
        ev("question.asked", { questionId: "q", question: { prompt: "p", reason: "r", kind: "text", default: "d" } }, { agent: "specialist", stepId: "s1" }),
      ],
      true,
    )
    expect(t.run("s1").map((e) => `${e.kind}:${e.failed}`)).toEqual(["note:true", "result:true"])
  })
})
