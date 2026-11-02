import type { ContextPackage, Evidence } from "../../../src/shared/context"
import type { StepRow, TaskRow, TaskState } from "../../../src/shared/types"
import { canClose, canContinue, canDelete, canStop, type ToolItem } from "../../../src/renderer/src/lib/chat"
import { tokens, usd } from "../../../src/renderer/src/lib/format"
import { canRetry, isLive, type FilesTouched } from "../../../src/renderer/src/lib/store"

/*
  What the transcript says about each item, as text (specs/tui-conversation R1.3, R1.4, R2.1, R2.2): a tool call on
  one line, a delegation's sections, the working line, and the actions a task's state offers. Pure, so the screen only
  lays these out.
*/

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The argument that says most about a call: a path, a command, a pattern or a query, else the first string. */
export function argSummary(input: string, max = 80): string {
  let args: unknown
  try {
    args = JSON.parse(input)
  } catch {
    return oneLine(input, max)
  }
  if (!args || typeof args !== "object") return oneLine(String(args ?? ""), max)
  const o = args as Record<string, unknown>
  for (const k of ["file_path", "path", "command", "pattern", "query", "objective", "url", "glob"])
    if (typeof o[k] === "string" && o[k]) return oneLine(o[k] as string, max)
  const first = Object.values(o).find((v) => typeof v === "string" && v)
  return first ? oneLine(first as string, max) : ""
}

export type CallState = "running" | "failed" | "done"

export const callState = (t: Pick<ToolItem, "output" | "failed">): CallState => (t.output === undefined ? "running" : t.failed ? "failed" : "done")

/** A tool call on one line: its name and its telling argument (R1.3). */
export function toolLine(t: ToolItem): string {
  const arg = argSummary(t.input)
  return arg ? `${t.name}(${arg})` : t.name
}

/** A tool call opened: its arguments as indented JSON, then its output, cut to a screenful (R1.3). */
export function toolDetails(t: ToolItem, maxLines = 40): { input: string; output: string } {
  let input = t.input
  try {
    input = JSON.stringify(JSON.parse(t.input), null, 2)
  } catch {
    // shown as it came
  }
  const cut = (s: string) => {
    const lines = s.split("\n")
    return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n") : s
  }
  return { input: cut(input), output: t.output === undefined ? "" : cut(t.output) }
}

export interface Section {
  title: string
  lines: string[]
}

/** A delegation opened: its context package, report, evidence and files, each a titled list of lines (R1.4). */
export function delegationSections(step: StepRow, files: FilesTouched): Section[] {
  const pkg = step.data.context as ContextPackage | undefined
  const report = typeof step.data.report === "string" ? step.data.report : ""
  const evidence = (step.data.evidence as Evidence[] | undefined) ?? []
  const error = typeof step.data.error === "string" ? step.data.error : ""
  const out: Section[] = []
  if (error) out.push({ title: "Error", lines: [error] })
  if (pkg) {
    const lines = [`Objective: ${pkg.objective}`, `Mode: ${pkg.mode} · ${pkg.files.length} files`]
    for (const [title, list] of [
      ["Questions", pkg.questions],
      ["Constraints", pkg.constraints],
      ["Environment", pkg.environment],
    ] as const)
      if (list?.length) lines.push(`${title}:`, ...list.map((q) => `  • ${q}`))
    if (pkg.excerpts?.length) lines.push("Excerpts:", ...pkg.excerpts.map((e) => `  ${e.path}:${e.startLine}-${e.endLine}${e.note ? ` — ${e.note}` : ""}`))
    if (pkg.brief) lines.push("Brief:", ...pkg.brief.split("\n").map((l) => `  ${l}`))
    out.push({ title: "Context package", lines })
  }
  if (report) out.push({ title: "Report", lines: [report] })
  if (evidence.length)
    out.push({
      title: `Evidence (${evidence.length})`,
      lines: evidence.map((e) => `${e.ref ?? (e.path ? `${e.path}:${e.startLine}-${e.endLine}` : "")} — ${oneLine(e.claim, 200)}`),
    })
  const fileLines = (["copy", "read", "write", "apply"] as const).filter((op) => files[op].length).map((op) => `${op}: ${files[op].join(", ")}`)
  if (fileLines.length) out.push({ title: "Files", lines: fileLines })
  return out
}

/** `1m 05s`, `42s`, `1h 02m`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** The working line while a turn runs: what it does, for how long, and what the task spent (R2.1). */
export function workingLine(task: Pick<TaskRow, "tokensIn" | "tokensOut" | "costUsd" | "specialistCostUsd">, state: TaskState, since: number, now: number): string {
  const what = state === "pending" ? "Starting the sandbox" : state === "waiting" ? "Waiting for you" : "Working"
  const cost = task.costUsd + task.specialistCostUsd
  return `${what} · ${elapsed(now - since)} · ${tokens(task.tokensIn + task.tokensOut)} tokens · ${usd(cost)}`
}

export type TaskAction = "stop" | "continue" | "close" | "cancel" | "retry" | "delete"

/** The actions the task's state offers, in the order the TUI lists them (R2.2). */
export function actionsFor(state: TaskState): TaskAction[] {
  const out: TaskAction[] = []
  if (canStop(state)) out.push("stop")
  if (canContinue(state)) out.push("continue")
  if (canClose(state)) out.push("close")
  if (isLive(state)) out.push("cancel")
  if (canRetry(state)) out.push("retry")
  if (canDelete(state)) out.push("delete")
  return out
}
