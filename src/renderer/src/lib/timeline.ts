import type { EventRow, StepRow } from "@shared/types"
import { ChatFold, type ChatItem, type ToolItem } from "./chat"

/*
  The task view's timeline (specs/chat-timeline): the conversation folded from a page of the event log,
  newer events folded onto it as they arrive without refolding the rest (R3.2), and the specialist's
  own work kept under the delegation that ran it (R1.1, R1.3). An older page refolds once, from the
  oldest event loaded.
*/

/** One entry of a specialist's run, shown under its delegation, collapsed until opened (R1.2). */
export interface SpecialistEntry {
  id: string
  at: number
  kind: "text" | "thinking" | "tool" | "result" | "note"
  /** one line */
  title: string
  /** what opening the entry shows: the text, the tool's input, the event's output */
  body: string
  /** a tool's result, once it returned */
  output?: string
  /** how long a tool still running has run, in seconds, from Claude Code's heartbeats (specs/chat-timeline R1.4) */
  elapsedSeconds?: number
  failed: boolean
  /** the subagent of the specialist that made it, when not the specialist itself */
  subagent?: string
}

const text = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2))
const FAILED = new Set(["delegation.failed", "delegation.timeout", "delegation.auth", "delegation.limit", "sandbox.refused", "patch.conflict"])

export class Timeline {
  /** the events loaded, oldest first */
  readonly events: EventRow[]
  private readonly chat: ChatFold
  private readonly runs = new Map<string, SpecialistEntry[]>()
  private readonly calls = new Map<string, SpecialistEntry>()

  /** `fromStart`: the first event given is the task's first, so nothing older is missing */
  constructor(
    steps: StepRow[],
    events: EventRow[],
    readonly fromStart: boolean,
  ) {
    this.events = []
    this.chat = new ChatFold(steps, fromStart)
    this.append(events)
  }

  get items(): ChatItem[] {
    return this.chat.items
  }

  get lastId(): number {
    return this.events.at(-1)?.id ?? 0
  }

  get firstId(): number {
    return this.events[0]?.id ?? 0
  }

  /** Fold newer events in; an event already folded is skipped (R3.2). Returns whether anything changed. */
  append(events: EventRow[]): boolean {
    const fresh = events.filter((e) => e.id > this.lastId)
    if (!fresh.length) return false
    this.events.push(...fresh)
    this.chat.add(fresh)
    for (const e of fresh) this.specialist(e)
    return true
  }

  /** A timeline that starts at an older page: refolded once, from its first event (R2.3). */
  prepend(older: EventRow[], steps: StepRow[], fromStart: boolean): Timeline {
    return new Timeline(steps, [...older.filter((e) => e.id < this.firstId), ...this.events], fromStart)
  }

  /** The specialist's entries for a delegation step, oldest first. */
  run(stepId: string): SpecialistEntry[] {
    return this.runs.get(stepId) ?? []
  }

  private specialist(e: EventRow) {
    // A question stays in the conversation, where it is answered.
    if (!e.stepId || (e.agent !== "specialist" && e.agent !== "sandbox") || e.kind.startsWith("question.")) return
    const p = e.payload
    const base = { id: `e${e.id}`, at: e.at, failed: false, ...(typeof p.subagent === "string" ? { subagent: p.subagent } : {}) }
    let entry: SpecialistEntry | null = null
    switch (e.kind) {
      case "specialist.text":
      case "specialist.thinking":
        entry = { ...base, kind: e.kind === "specialist.text" ? "text" : "thinking", title: e.summary, body: text(p.output) }
        break
      case "specialist.tool.call":
        entry = { ...base, kind: "tool", title: e.summary, body: text(p.input) }
        if (typeof p.callId === "string") this.calls.set(p.callId, entry)
        break
      case "specialist.tool.progress": {
        // A heartbeat updates the call it belongs to; it is not an entry of its own (R1.4).
        const call = typeof p.callId === "string" ? this.calls.get(p.callId) : undefined
        if (call && call.output === undefined && typeof p.elapsedSeconds === "number") call.elapsedSeconds = p.elapsedSeconds
        return
      }
      case "specialist.tool.result": {
        const call = typeof p.callId === "string" ? this.calls.get(p.callId) : undefined
        if (call) {
          call.output = text(p.output)
          call.failed = p.error !== undefined
          return
        }
        entry = { ...base, kind: "note", title: e.summary, body: text(p.output), failed: p.error !== undefined }
        break
      }
      case "specialist.result":
        entry = { ...base, kind: "result", title: e.summary, body: text(p.output), failed: p.error !== undefined }
        break
      default:
        entry = { ...base, kind: "note", title: e.summary, body: text(p.output ?? p.error ?? ""), failed: FAILED.has(e.kind) || p.error !== undefined }
    }
    const list = this.runs.get(e.stepId)
    if (list) list.push(entry)
    else this.runs.set(e.stepId, [entry])
  }
}

/** The delegation step a `delegate_to_specialist` call started: by the call's id, or by order in a whole log. */
export function stepOf(item: ToolItem, steps: StepRow[]): StepRow | undefined {
  if (item.callId) return steps.find((s) => s.kind === "delegation" && s.data.callId === item.callId)
  return item.stepId ? steps.find((s) => s.id === item.stepId) : undefined
}
