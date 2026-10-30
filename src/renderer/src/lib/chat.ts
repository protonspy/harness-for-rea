import type { Answer, Origin, Question, ToolDecision } from "@shared/chat"
import type { EventRow, StepRow, TaskState } from "@shared/types"

/*
  The task as a conversation (specs/chat R7.1), folded from its event log in order: the user's and
  the agent's messages, the orchestrator's tool calls with their results, the gated calls waiting on
  the user, the questions either agent asked, and the turn's stops and ends. A pure function of the
  log, so a reopened task renders exactly as it did live.
*/

export interface UserItem {
  kind: "user"
  id: string
  at: number
  text: string
  /** the orchestrator has read it (specs/chat R2.2); the opening request always has */
  read: boolean
}

export interface AgentItem {
  kind: "agent"
  id: string
  at: number
  text: string
}

export interface ToolItem {
  kind: "tool"
  id: string
  at: number
  name: string
  input: string
  output?: string
  failed: boolean
  /** the delegation this call started, for `delegate_to_specialist` */
  stepId?: string
}

export interface GatedCall {
  callId: string
  name: string
  args: Record<string, unknown>
  decision?: ToolDecision
  origin?: Origin
}

export interface ApprovalItem {
  kind: "approval"
  id: string
  at: number
  calls: GatedCall[]
}

export interface QuestionItem {
  kind: "question"
  id: string
  at: number
  agent: string
  stepId: string | null
  question: Question
  answer?: Answer
  origin?: Origin
}

export interface NoticeItem {
  kind: "notice"
  id: string
  at: number
  text: string
  tone: "neutral" | "warn" | "bad"
}

export type ChatItem = UserItem | AgentItem | ToolItem | ApprovalItem | QuestionItem | NoticeItem

const NOTICES: Record<string, NoticeItem["tone"]> = {
  "turn.stopped": "warn",
  "turn.continued": "neutral",
  "question.capped": "warn",
  "task.failed": "bad",
  "task.cancelled": "warn",
  "task.interrupted": "bad",
  "task.done": "neutral",
}

const ENDS = new Set(["task.done", "task.failed", "task.cancelled", "task.interrupted"])

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2))

export function conversation(events: EventRow[], steps: StepRow[] = []): ChatItem[] {
  const items: ChatItem[] = []
  const open = new Map<string, ToolItem[]>()
  const calls = new Map<string, GatedCall>()
  const questions = new Map<string, QuestionItem>()
  const delegations = steps.filter((s) => s.kind === "delegation").sort((a, b) => a.ord - b.ord)
  let delegated = 0
  let users = 0
  // Tasks run before the chat recorded no messages: their request and answer stand in for them.
  const legacy = !events.some((e) => e.kind === "message.user")
  for (const e of events) {
    const id = `e${e.id}`
    const p = e.payload
    switch (e.kind) {
      case "message.user":
        items.push({ kind: "user", id, at: e.at, text: str(p.output), read: users++ === 0 })
        break
      case "message.read": {
        const text = str(p.output)
        const waiting = items.find((i): i is UserItem => i.kind === "user" && !i.read && i.text === text)
        if (waiting) waiting.read = true
        break
      }
      case "message.agent":
        items.push({ kind: "agent", id, at: e.at, text: str(p.output) })
        break
      case "tool.call": {
        if (e.agent !== "orchestrator") break
        const name = String(p.tool ?? e.summary)
        const item: ToolItem = { kind: "tool", id, at: e.at, name, input: str(p.input), failed: false }
        if (name === "delegate_to_specialist") item.stepId = delegations[delegated++]?.id
        items.push(item)
        open.set(name, [...(open.get(name) ?? []), item])
        break
      }
      case "tool.result":
      case "tool.error": {
        const name = String(p.tool ?? "")
        const item = open.get(name)?.shift()
        if (!item) break
        item.output = e.kind === "tool.error" ? str(p.error) : str(p.output)
        item.failed = e.kind === "tool.error" || item.output.startsWith("ERROR:")
        break
      }
      case "approval.requested": {
        const requested = ((p.calls as GatedCall[] | undefined) ?? []).map((c) => ({ callId: c.callId, name: c.name, args: c.args ?? {} }))
        for (const c of requested) calls.set(c.callId, c)
        if (requested.length) items.push({ kind: "approval", id, at: e.at, calls: requested })
        break
      }
      case "approval.decided": {
        const call = calls.get(String(p.callId ?? ""))
        if (call) Object.assign(call, { decision: p.decision as ToolDecision, origin: p.origin as Origin })
        break
      }
      case "question.asked": {
        const q: QuestionItem = { kind: "question", id: String(p.questionId), at: e.at, agent: e.agent, stepId: e.stepId, question: p.question as Question }
        questions.set(q.id, q)
        items.push(q)
        break
      }
      case "question.answered": {
        const q = questions.get(String(p.questionId ?? ""))
        if (q) Object.assign(q, { answer: p.answer as Answer, origin: p.origin as Origin })
        break
      }
      case "task.started":
        if (legacy && p.input) items.push({ kind: "user", id, at: e.at, text: str(p.input), read: true })
        break
      default:
        // A task that ended settles whatever still waited on the user, so no card stays actionable.
        if (ENDS.has(e.kind)) {
          for (const c of calls.values()) if (!c.decision) Object.assign(c, { decision: { type: "reject" }, origin: "stopped" })
          for (const q of questions.values()) if (q.origin === undefined) Object.assign(q, { answer: q.question.default, origin: "stopped" })
        }
        if (legacy && e.kind === "task.done" && typeof p.output === "string" && p.output) items.push({ kind: "agent", id, at: e.at, text: p.output })
        else if (e.kind in NOTICES) items.push({ kind: "notice", id, at: e.at, text: e.summary, tone: NOTICES[e.kind] })
    }
  }
  return items
}

export type ChatBlock = Exclude<ChatItem, ToolItem> | { kind: "tools"; id: string; items: ToolItem[] } | (ToolItem & { delegation: true })

/** Consecutive plain tool calls as one run; a delegation stands on its own, as its card. */
export function blocks(items: ChatItem[]): ChatBlock[] {
  const out: ChatBlock[] = []
  for (const i of items) {
    if (i.kind !== "tool") out.push(i)
    else if (i.stepId) out.push({ ...i, delegation: true })
    else {
      const prev = out.at(-1)
      if (prev?.kind === "tools") prev.items.push(i)
      else out.push({ kind: "tools", id: i.id, items: [i] })
    }
  }
  return out
}

/** The gated calls still waiting for the user's decision. */
export function pendingCalls(items: ChatItem[]): GatedCall[] {
  return items.flatMap((i) => (i.kind === "approval" ? i.calls.filter((c) => !c.decision) : []))
}

/** The questions still waiting for the user's answer. */
export function pendingQuestions(items: ChatItem[]): QuestionItem[] {
  return items.filter((i): i is QuestionItem => i.kind === "question" && i.origin === undefined)
}

/** Whether the user can write to the task: while a turn runs or waits, on their turn, or after a stop (R7.2). */
export function canSend(state: TaskState): boolean {
  return ["pending", "running", "waiting", "awaiting-user", "stopped"].includes(state)
}

/** Whether a turn is under way and can be stopped (R3.1). */
export function canStop(state: TaskState): boolean {
  return ["pending", "running", "waiting"].includes(state)
}

/** Whether the conversation is open with no turn under way, so it can be closed. */
export function canClose(state: TaskState): boolean {
  return state === "awaiting-user" || state === "stopped"
}

/** A gated call's arguments as the user edits them: JSON text in, an object out, or why not. */
export function parseArgs(text: string): { args: Record<string, unknown> } | { error: string } {
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "The arguments must be a JSON object." }
    return { args: v as Record<string, unknown> }
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` }
  }
}

/** What the turn is doing, in a few words, for the bar above the message box (R7.2, R7.5). */
export function turnLabel(state: TaskState, waitingOn: number): string {
  switch (state) {
    case "pending":
      return "Starting the task's sandbox…"
    case "running":
      return "Working — your messages reach the orchestrator before its next step."
    case "waiting":
      return waitingOn ? `Waiting for you: ${waitingOn} ${waitingOn === 1 ? "decision" : "decisions"}.` : "Waiting for you."
    case "awaiting-user":
      return "Your turn."
    case "stopped":
      return "Stopped. Continue the turn, or send a message to continue with it."
    default:
      return "This conversation is closed."
  }
}
