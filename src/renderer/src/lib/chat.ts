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
  /** the call's id, which pairs its result and the delegation it started (specs/chat-timeline R1.1) */
  callId?: string
  /** the delegation this call started, for `delegate_to_specialist`, when it is known from the order of a whole log */
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

/**
  The fold behind `conversation`, kept between calls so new events are folded without the old ones
  (specs/chat-timeline R3.2). `fromStart` says the first event given is the task's first, so the first
  message is the opening request; a page that starts mid-task has none.
*/
export class ChatFold {
  readonly items: ChatItem[] = []
  private readonly open = new Map<string, ToolItem[]>()
  private readonly byCall = new Map<string, ToolItem>()
  private readonly calls = new Map<string, GatedCall>()
  private readonly questions = new Map<string, QuestionItem>()
  private readonly delegations: StepRow[]
  private delegated = 0
  private users: number
  /** the request of a task run before the chat recorded messages, until a message shows it was not one */
  private started: UserItem | null = null
  private sawUser = false

  constructor(steps: StepRow[] = [], fromStart = true) {
    // Steps that recorded no call id are paired with their calls by order, which only a whole log can do.
    this.delegations = steps.filter((s) => s.kind === "delegation" && !s.data.callId).sort((a, b) => a.ord - b.ord)
    this.users = fromStart ? 0 : 1
  }

  add(events: EventRow[]): this {
    for (const e of events) this.one(e)
    return this
  }

  private one(e: EventRow) {
    const { items } = this
    const id = `e${e.id}`
    const p = e.payload
    switch (e.kind) {
      case "message.user":
        if (this.started && !this.sawUser) {
          items.splice(items.indexOf(this.started), 1)
          this.started = null
        }
        this.sawUser = true
        items.push({ kind: "user", id, at: e.at, text: str(p.output), read: this.users++ === 0 })
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
        if (typeof p.callId === "string" && p.callId) {
          item.callId = p.callId
          this.byCall.set(p.callId, item)
        } else {
          if (name === "delegate_to_specialist") item.stepId = this.delegations[this.delegated++]?.id
          this.open.set(name, [...(this.open.get(name) ?? []), item])
        }
        items.push(item)
        break
      }
      case "tool.result":
      case "tool.error": {
        const callId = typeof p.callId === "string" ? p.callId : ""
        const item = callId ? this.byCall.get(callId) : this.open.get(String(p.tool ?? ""))?.shift()
        if (!item) break
        this.byCall.delete(callId)
        item.output = e.kind === "tool.error" ? str(p.error) : str(p.output)
        item.failed = e.kind === "tool.error" || item.output.startsWith("ERROR:")
        break
      }
      case "approval.requested": {
        const requested = ((p.calls as GatedCall[] | undefined) ?? []).map((c) => ({ callId: c.callId, name: c.name, args: c.args ?? {} }))
        for (const c of requested) this.calls.set(c.callId, c)
        if (requested.length) items.push({ kind: "approval", id, at: e.at, calls: requested })
        break
      }
      case "approval.decided": {
        const call = this.calls.get(String(p.callId ?? ""))
        if (call) Object.assign(call, { decision: p.decision as ToolDecision, origin: p.origin as Origin })
        break
      }
      case "question.asked": {
        const q: QuestionItem = { kind: "question", id: String(p.questionId), at: e.at, agent: e.agent, stepId: e.stepId, question: p.question as Question }
        this.questions.set(q.id, q)
        items.push(q)
        break
      }
      case "question.answered": {
        const q = this.questions.get(String(p.questionId ?? ""))
        if (q) Object.assign(q, { answer: p.answer as Answer, origin: p.origin as Origin })
        break
      }
      case "task.started":
        // Tasks run before the chat recorded no messages: their request and answer stand in for them.
        if (p.input && !this.sawUser) {
          this.started = { kind: "user", id, at: e.at, text: str(p.input), read: true }
          items.push(this.started)
        }
        break
      default:
        // A task that ended settles whatever still waited on the user, so no card stays actionable.
        if (ENDS.has(e.kind)) {
          for (const c of this.calls.values()) if (!c.decision) Object.assign(c, { decision: { type: "reject" }, origin: "stopped" })
          for (const q of this.questions.values()) if (q.origin === undefined) Object.assign(q, { answer: q.question.default, origin: "stopped" })
        }
        if (this.started && !this.sawUser && e.kind === "task.done" && typeof p.output === "string" && p.output)
          items.push({ kind: "agent", id, at: e.at, text: p.output })
        else if (e.kind in NOTICES) items.push({ kind: "notice", id, at: e.at, text: e.summary, tone: NOTICES[e.kind] })
    }
  }
}

/** The task as a conversation: a pure function of the log, so a reopened task renders exactly as it did live. */
export function conversation(events: EventRow[], steps: StepRow[] = []): ChatItem[] {
  return new ChatFold(steps).add(events).items
}

export type ChatBlock = Exclude<ChatItem, ToolItem> | { kind: "tools"; id: string; items: ToolItem[] } | (ToolItem & { delegation: true })

/** Consecutive plain tool calls as one run; a delegation stands on its own, as its card. */
export function blocks(items: ChatItem[]): ChatBlock[] {
  const out: ChatBlock[] = []
  for (const i of items) {
    if (i.kind !== "tool") out.push(i)
    else if (i.stepId || i.name === "delegate_to_specialist") out.push({ ...i, delegation: true })
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

/** States a task ended in that it can be continued from, on Continue or a message (specs/task-persistence R2). */
export const ENDED_STATES: TaskState[] = ["cancelled", "failed", "interrupted", "done"]

/**
  Whether the user can write to the task: while a turn runs or waits, on their turn, after a stop (R7.2), and once it
  ended, which reopens it where it stopped (specs/task-persistence R2.2).
*/
export function canSend(state: TaskState): boolean {
  return ["pending", "running", "waiting", "awaiting-user", "stopped", ...ENDED_STATES].includes(state)
}

/** Whether the task can be continued from where it stopped: a stopped turn, or a task that ended (specs/task-persistence R2.1). */
export function canContinue(state: TaskState): boolean {
  return state === "stopped" || ENDED_STATES.includes(state)
}

/** Whether the task can be deleted: anything but a turn under way (specs/task-persistence R4.2). */
export function canDelete(state: TaskState): boolean {
  return !canStop(state)
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
      return "Ended. Its history and files are kept: continue it, or send a message to pick up where it stopped."
  }
}
