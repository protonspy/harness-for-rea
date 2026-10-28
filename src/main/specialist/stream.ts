import type { EventPayload, FileTouch } from "@shared/types"

/*
  Claude Code's stream-json, line by line, into events (specs/claude-specialist R2): text, thinking,
  tool calls and results attributed to the subagent that made them, the final result with usage
  and cost, and every line the reader does not know kept rather than dropped. Ported from
  study-lab's `stream.ts` with the caps and subagent attribution of MagnoTech's `leitorDoStream.ts`.
*/

export const ARGS_CAP = 4 * 1024
export const RESULT_CAP = 16 * 1024
export const TEXT_CAP = 32 * 1024

// The text comes from files the user handed in: no control characters.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

export function clean(v: unknown): string {
  return String(v ?? "").replace(CONTROL, "")
}

function cap(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"])

/** `/work/src/a.ts` → `src/a.ts`; anything outside /work is reported as it is. */
export function fromWork(p: string): string {
  const s = p.replace(/\\/g, "/")
  if (s === "/work") return "."
  return s.startsWith("/work/") ? s.slice(6) : s
}

/** The files a tool call reads or writes, by source-relative path (R2.5). */
export function filesOf(tool: string, input: Record<string, unknown>): FileTouch[] {
  const op = WRITE_TOOLS.has(tool) ? "write" : READ_TOOLS.has(tool) ? "read" : null
  if (!op) return []
  const p = input.file_path ?? input.notebook_path ?? input.path
  return typeof p === "string" && p ? [{ path: fromWork(clean(p)), op }] : []
}

export interface StreamEvent {
  kind: "init" | "text" | "thinking" | "tool.call" | "tool.result" | "result" | "unknown"
  summary: string
  payload: EventPayload
}

export interface StreamResult {
  text: string
  error: boolean
  session: string | null
  durationMs: number
  /** Claude Code's `total_cost_usd`: an estimate against the user's plan */
  costUsd: number | null
  tokensIn: number
  tokensOut: number
  cacheTokens: number
  model: string
  /** the error subtype or API status when it failed */
  reason?: string
}

interface Block {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const KNOWN = new Set(["system", "assistant", "user", "result", "stream_event", "rate_limit_event"])

export class StreamReader {
  session: string | null = null
  model = ""
  /** the last result; a multi-turn session has one per turn */
  result: StreamResult | null = null
  private readonly subagents = new Map<string, string>()
  private readonly tools = new Map<string, string>()

  /** One line of stdout: the events it brings. */
  line(raw: string): StreamEvent[] {
    if (!raw.trim()) return []
    let e: unknown
    try {
      e = JSON.parse(raw)
    } catch {
      return [{ kind: "unknown", summary: "Unparsed output line", payload: { output: cap(clean(raw), RESULT_CAP).text } }]
    }
    if (!isObj(e)) return [{ kind: "unknown", summary: "Output line that is not an object", payload: { output: cap(clean(raw), RESULT_CAP).text } }]
    if (typeof e.session_id === "string") this.session = e.session_id
    const type = clean(e.type)
    if (type === "system" && e.subtype === "init") return [this.init(e)]
    if (type === "assistant") return this.assistant(e)
    if (type === "user") return this.results(e)
    if (type === "result") return [this.finish(e)]
    if (KNOWN.has(type)) return []
    return [{ kind: "unknown", summary: `Unknown stream event type: ${type || "(none)"}`, payload: { output: cap(clean(raw), RESULT_CAP).text } }]
  }

  private init(e: Record<string, unknown>): StreamEvent {
    if (typeof e.model === "string") this.model = clean(e.model)
    const tools = Array.isArray(e.tools) ? e.tools.map(clean) : []
    return { kind: "init", summary: `Claude Code started (${this.model || "model unknown"})`, payload: { model: this.model, tools } }
  }

  private agentOf(parent: unknown): { subagent?: string } {
    if (typeof parent !== "string" || !parent) return {}
    return { subagent: this.subagents.get(parent) ?? "general-purpose" }
  }

  private blocks(e: Record<string, unknown>): Block[] {
    const m = isObj(e.message) ? e.message : {}
    return Array.isArray(m.content) ? (m.content as Block[]) : []
  }

  private assistant(e: Record<string, unknown>): StreamEvent[] {
    const out: StreamEvent[] = []
    const who = this.agentOf(e.parent_tool_use_id)
    for (const b of this.blocks(e)) {
      if (b.type === "thinking" && b.thinking?.trim()) {
        const t = cap(clean(b.thinking), TEXT_CAP)
        out.push({ kind: "thinking", summary: t.text.split("\n")[0], payload: { output: t.text, ...who, ...(t.truncated ? { truncated: true } : {}) } })
      } else if (b.type === "text" && b.text?.trim()) {
        const t = cap(clean(b.text), TEXT_CAP)
        out.push({ kind: "text", summary: t.text.split("\n")[0], payload: { output: t.text, ...who, ...(t.truncated ? { truncated: true } : {}) } })
      } else if (b.type === "tool_use") out.push(this.call(b, who))
    }
    return out
  }

  private call(b: Block, who: { subagent?: string }): StreamEvent {
    const id = clean(b.id)
    const tool = clean(b.name)
    this.tools.set(id, tool)
    let input = isObj(b.input) ? b.input : {}
    if (tool === "Agent" || tool === "Task") {
      const role = clean(input.subagent_type || "general-purpose")
      this.subagents.set(id, role)
      input = { subagent_type: role, description: clean(input.description ?? input.prompt) }
    }
    const files = filesOf(tool, input)
    const args = cap(JSON.stringify(input), ARGS_CAP)
    const target = files[0]?.path ?? ""
    return {
      kind: "tool.call",
      summary: `${tool}${target ? ` ${target}` : ""}`,
      payload: { tool, callId: id, input: args.text, files, ...who, ...(args.truncated ? { truncated: true } : {}) },
    }
  }

  private results(e: Record<string, unknown>): StreamEvent[] {
    const out: StreamEvent[] = []
    const who = this.agentOf(e.parent_tool_use_id)
    for (const b of this.blocks(e)) {
      if (b.type !== "tool_result") continue
      const id = clean(b.tool_use_id)
      const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? (b.content as Block[]) : []
      const text = cap(
        parts
          .filter((p) => p.type === "text")
          .map((p) => clean(p.text))
          .join("\n"),
        RESULT_CAP,
      )
      const tool = this.tools.get(id) ?? ""
      const error = b.is_error === true
      out.push({
        kind: "tool.result",
        summary: `${tool || "tool"} ${error ? "failed" : "returned"}${text.text ? `: ${text.text.split("\n")[0]}` : ""}`,
        payload: {
          tool,
          callId: id,
          output: text.text,
          ...(error ? { error: text.text.slice(0, 500) || "failed" } : {}),
          ...who,
          ...(text.truncated ? { truncated: true } : {}),
        },
      })
    }
    return out
  }

  private finish(e: Record<string, unknown>): StreamEvent {
    const u = isObj(e.usage) ? e.usage : {}
    const models = isObj(e.modelUsage) ? Object.keys(e.modelUsage) : []
    const error = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")
    const r: StreamResult = {
      text: clean(e.result).trim(),
      error,
      session: this.session,
      durationMs: num(e.duration_ms),
      costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      tokensIn: num(u.input_tokens),
      tokensOut: num(u.output_tokens),
      cacheTokens: num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
      model: this.model || models[0] || "claude",
      reason: error ? clean(e.api_error_status ?? e.subtype ?? "") || undefined : undefined,
    }
    this.result = r
    const t = cap(r.text, TEXT_CAP)
    return {
      kind: "result",
      summary: error ? `Specialist failed: ${r.reason ?? (t.text.split("\n")[0] || "error")}` : `Specialist answered in ${(r.durationMs / 1000).toFixed(1)} s`,
      payload: {
        output: t.text,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        cacheTokens: r.cacheTokens,
        ...(r.costUsd !== null ? { costUsd: r.costUsd, estimate: true } : {}),
        durationMs: r.durationMs,
        session: r.session,
        ...(error ? { error: r.reason ?? "error" } : {}),
        ...(t.truncated ? { truncated: true } : {}),
      },
    }
  }
}
