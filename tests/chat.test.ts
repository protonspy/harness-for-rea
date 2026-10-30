import { describe, expect, it } from "vitest"
import { checkAnswer, questionProblem, QuestionSchema, type Question } from "../src/shared/chat"
import type { EventRow, StepRow } from "../src/shared/types"
import {
  blocks,
  canClose,
  canSend,
  canStop,
  conversation,
  parseArgs,
  pendingCalls,
  pendingQuestions,
  turnLabel,
  type AgentItem,
  type ApprovalItem,
  type NoticeItem,
  type QuestionItem,
  type ToolItem,
  type UserItem,
} from "../src/renderer/src/lib/chat"

/* specs/chat R5.3: a question carries a prompt, a reason, a kind and a default that fits the kind. */

const q = (o: Partial<Question>): Question => ({ prompt: "Which build?", reason: "Two exist", kind: "text", default: "", ...o })

describe("questions (R5.3)", () => {
  it("requires a prompt, a reason, a known kind and a default", () => {
    expect(QuestionSchema.safeParse({ prompt: "p", reason: "r", kind: "text", default: "d" }).success).toBe(true)
    expect(QuestionSchema.safeParse({ prompt: "p", kind: "text", default: "d" }).success).toBe(false)
    expect(QuestionSchema.safeParse({ prompt: "p", reason: "r", kind: "essay", default: "d" }).success).toBe(false)
    expect(QuestionSchema.safeParse({ prompt: "p", reason: "r", kind: "text" }).success).toBe(false)
  })

  it("finds a default that does not fit its kind", () => {
    expect(questionProblem(q({ kind: "choice", choices: ["debug", "release"], default: "debug" }))).toBeNull()
    expect(questionProblem(q({ kind: "choice", choices: ["debug"], default: "debug" }))).toMatch(/two choices/)
    expect(questionProblem(q({ kind: "choice", choices: ["debug", "release"], default: "other" }))).toMatch(/one of the choices/)
    expect(questionProblem(q({ kind: "yesno", default: true }))).toBeNull()
    expect(questionProblem(q({ kind: "yesno", default: "yes" }))).toMatch(/true or false/)
    expect(questionProblem(q({ kind: "number", default: 3 }))).toBeNull()
    expect(questionProblem(q({ kind: "number", default: "3" }))).toMatch(/number/)
    expect(questionProblem(q({ kind: "text", default: "x" }))).toBeNull()
    expect(questionProblem(q({ kind: "text", default: 1 }))).toMatch(/text/)
  })

  it("accepts only the answer the kind calls for", () => {
    const choice = q({ kind: "choice", choices: ["debug", "release"], default: "debug" })
    expect(checkAnswer(choice, "release")).toBe("release")
    expect(() => checkAnswer(choice, "other")).toThrow(/choice/)
    expect(checkAnswer(q({ kind: "yesno", default: false }), true)).toBe(true)
    expect(() => checkAnswer(q({ kind: "yesno", default: false }), "true")).toThrow(/yesno/)
    expect(checkAnswer(q({ kind: "number", default: 0 }), 4)).toBe(4)
    expect(() => checkAnswer(q({ kind: "number", default: 0 }), "4")).toThrow(/number/)
    expect(checkAnswer(q({ kind: "text" }), "free")).toBe("free")
    expect(() => checkAnswer(q({ kind: "text" }), 4)).toThrow(/text/)
  })
})

describe("the conversation the chat renders (R7.1–R7.5)", () => {
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
  const step = (id: string, ord: number): StepRow => ({
    id,
    taskId: "t",
    ord,
    kind: "delegation",
    title: id,
    agent: "specialist",
    state: "done",
    data: {},
    createdAt: 0,
    updatedAt: 0,
  })
  const choice = { prompt: "Which build?", reason: "r", kind: "choice", choices: ["a", "b"], default: "a" }

  it("folds the log into messages, tool calls with results, approvals, questions and notices, in order", () => {
    const items = conversation(
      [
        ev("task.started"),
        ev("message.user", { output: "Find the bug" }, { agent: "app" }),
        ev("message.agent", { output: "Looking." }),
        ev("tool.call", { tool: "read_file", input: "{}" }),
        ev("message.user", { output: "Focus on split" }, { agent: "app" }),
        ev("tool.result", { tool: "read_file", output: "contents" }),
        ev("tool.call", { tool: "delegate_to_specialist", input: "{}" }),
        ev("specialist.text", {}, { agent: "specialist" }),
        ev("tool.result", { tool: "delegate_to_specialist", output: "ERROR: Docker is unavailable" }),
        ev("approval.requested", { calls: [{ callId: "c1", name: "execute", args: { command: "ls" } }] }),
        ev("approval.decided", { callId: "c1", decision: { type: "reject", message: "no" }, origin: "user" }, { agent: "app" }),
        ev("question.asked", { questionId: "q1", question: choice, agent: "specialist" }, { agent: "specialist", stepId: "s1" }),
        ev("turn.stopped", {}, { agent: "app", summary: "You stopped the turn" }),
      ],
      [step("s1", 1)],
    )
    expect(items.map((i) => i.kind)).toEqual(["user", "agent", "tool", "user", "tool", "approval", "question", "notice"])
    const [first, , read, later, delegate, approval, question, notice] = items as [
      UserItem,
      AgentItem,
      ToolItem,
      UserItem,
      ToolItem,
      ApprovalItem,
      QuestionItem,
      NoticeItem,
    ]
    expect(first).toMatchObject({ text: "Find the bug", read: true })
    expect(later).toMatchObject({ text: "Focus on split", read: false })
    expect(read).toMatchObject({ name: "read_file", output: "contents", failed: false })
    expect(delegate).toMatchObject({ name: "delegate_to_specialist", stepId: "s1", failed: true })
    expect(approval.calls).toEqual([{ callId: "c1", name: "execute", args: { command: "ls" }, decision: { type: "reject", message: "no" }, origin: "user" }])
    expect(question).toMatchObject({ id: "q1", agent: "specialist", stepId: "s1" })
    expect(question.answer).toBeUndefined()
    expect(notice).toMatchObject({ text: "You stopped the turn", tone: "warn" })
    expect(pendingCalls(items)).toEqual([])
    expect(pendingQuestions(items).map((x) => x.id)).toEqual(["q1"])
  })

  it("marks a mid-turn message read once the agent reads it, and settles answered questions and decided calls", () => {
    const items = conversation([
      ev("message.user", { output: "go" }, { agent: "app" }),
      ev("message.user", { output: "also b.ts" }, { agent: "app" }),
      ev("message.read", { output: "also b.ts" }),
      ev("approval.requested", {
        calls: [
          { callId: "c1", name: "apply_patch", args: { patchId: "p" } },
          { callId: "c2", name: "execute", args: {} },
        ],
      }),
      ev("approval.decided", { callId: "c1", decision: { type: "approve" }, origin: "user" }),
      ev("question.asked", { questionId: "q1", question: choice }),
      ev("question.answered", { questionId: "q1", answer: "b", origin: "user" }),
    ])
    expect((items[1] as UserItem).read).toBe(true)
    expect(pendingCalls(items).map((c) => c.callId)).toEqual(["c2"])
    expect(pendingQuestions(items)).toEqual([])
    expect(items.find((i): i is QuestionItem => i.kind === "question")).toMatchObject({ answer: "b", origin: "user" })
  })

  it("leaves nothing waiting on the user once the task has ended", () => {
    const waiting = [
      ev("approval.requested", { calls: [{ callId: "c1", name: "execute", args: {} }] }),
      ev("question.asked", { questionId: "q1", question: choice }),
    ]
    expect(pendingCalls(conversation(waiting))).toHaveLength(1)
    for (const end of ["task.done", "task.failed", "task.cancelled", "task.interrupted"]) {
      const items = conversation([...waiting, ev(end, {})])
      expect(pendingCalls(items), end).toEqual([])
      expect(pendingQuestions(items), end).toEqual([])
      expect(items.find((i): i is QuestionItem => i.kind === "question")).toMatchObject({ answer: choice.default, origin: "stopped" })
    }
  })

  it("keeps the message box open while the conversation is, and offers stop and close by state", () => {
    expect((["running", "waiting", "awaiting-user", "stopped"] as const).every(canSend)).toBe(true)
    expect((["done", "failed", "cancelled", "interrupted"] as const).some(canSend)).toBe(false)
    expect([canStop("running"), canStop("waiting"), canStop("awaiting-user"), canStop("stopped")]).toEqual([true, true, false, false])
    expect([canClose("awaiting-user"), canClose("stopped"), canClose("running")]).toEqual([true, true, false])
  })

  it("shows a task run before the chat as its request and its answer", () => {
    const items = conversation([ev("task.started", { input: "Old request" }), ev("tool.call", { tool: "ls" }), ev("task.done", { output: "Old answer" })])
    expect(items.map((i) => `${i.kind}:${"text" in i ? i.text : ""}`)).toEqual(["user:Old request", "tool:", "agent:Old answer"])
    expect(conversation([ev("task.started", { input: "x" }), ev("message.user", { output: "x" })]).filter((i) => i.kind === "user")).toHaveLength(1)
  })

  it("folds consecutive tool calls into one run and keeps a delegation on its own", () => {
    const items = conversation(
      [
        ev("tool.call", { tool: "ls" }),
        ev("tool.call", { tool: "grep" }),
        ev("tool.call", { tool: "delegate_to_specialist" }),
        ev("tool.call", { tool: "read_file" }),
        ev("message.agent", { output: "done" }),
      ],
      [step("s1", 1)],
    )
    expect(blocks(items).map((b) => (b.kind === "tools" ? `tools:${b.items.length}` : b.kind))).toEqual(["tools:2", "tool", "tools:1", "agent"])
  })

  it("parses edited arguments as a JSON object", () => {
    expect(parseArgs('{"command":"ls"}')).toEqual({ args: { command: "ls" } })
    expect(parseArgs("[1]")).toEqual({ error: "The arguments must be a JSON object." })
    expect(parseArgs("{nope")).toMatchObject({ error: expect.stringMatching(/^Not valid JSON/) })
  })

  it("says what the turn is doing and whose turn it is", () => {
    expect(turnLabel("awaiting-user", 0)).toBe("Your turn.")
    expect(turnLabel("waiting", 2)).toBe("Waiting for you: 2 decisions.")
    expect(turnLabel("waiting", 1)).toBe("Waiting for you: 1 decision.")
    expect(turnLabel("stopped", 0)).toMatch(/^Stopped/)
    expect(turnLabel("running", 0)).toMatch(/before its next step/)
    expect(turnLabel("done", 0)).toMatch(/closed/)
  })
})
