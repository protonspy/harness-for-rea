import { checkAnswer, type Answer, type Question } from "../../src/shared/chat"
import type { ProjectRow, Readiness, StepRow, TaskRow } from "../../src/shared/types"
import { pendingQuestions, type ChatBlock, type ChatItem, type QuestionItem } from "../../src/renderer/src/lib/chat"
import { stepOf, type SpecialistEntry } from "../../src/renderer/src/lib/timeline"

/*
  What the TUI's screens show, as lines of text (specs/tui R2.1, R3.1–R3.4), and how the one input line is read:
  a command, an answer to the question that waits, or a message. Pure, so it is tested like the renderer's lib/.
*/

// C0 and C1 controls but the newline, and DEL.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

const mark = (ready: boolean) => (ready ? "[x]" : "[ ]")

/** The first-run setup's three steps, each with its state and what readies it (R2.1). */
export function setupLines(r: Readiness): string[] {
  return [
    `${mark(r.sandbox.ready)} Sandbox images${r.sandbox.building ? " (preparing…)" : ""}${r.sandbox.ready ? "" : ` — ${r.sandbox.reason}`}`,
    `${mark(r.claude.ready)} Claude sign-in${r.claude.ready ? ` — ${r.claude.plan ?? "signed in"}${r.claude.email ? ` as ${r.claude.email}` : ""}` : ` — ${r.claude.reason}`}`,
    `${mark(r.model.ready)} Orchestrator — ${r.model.provider} · ${r.model.model}${r.model.ready ? "" : ` — ${r.model.reason}`}`,
    "",
    r.ready
      ? "Every step is ready: /done completes the setup."
      : "/images prepares the sandbox images · /login signs Claude in · /key <key> sets the provider's key · /model <id> picks the model",
  ]
}

export function projectLabel(p: ProjectRow): string {
  return `${p.name} — ${p.goal}, ${p.targetKind} · ${p.model}`
}

export function taskLabel(t: TaskRow): string {
  return `[${t.state}] ${t.request.replace(/\s+/g, " ").slice(0, 100)}`
}

/** A project's header (R3.2). */
export function projectLines(p: ProjectRow): string[] {
  return [`${p.name}`, `${p.goal} · ${p.targetKind} · ${p.targetPath}`, `${p.provider} · ${p.model}`, "", "Type a request to start a task, or pick one below."]
}

const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((l, i) => (i === 0 ? l : `${by}${l}`))
    .join("\n")
const oneLine = (s: string, max = 140) => s.replace(/\s+/g, " ").trim().slice(0, max)

function runLines(run: SpecialistEntry[]): string[] {
  return run.map((e) => `      ${e.failed ? "!" : "·"} ${e.kind === "tool" && e.output === undefined ? "(running) " : ""}${oneLine(e.title)}`)
}

/** The chat timeline as lines: messages, tool calls, delegations with the specialist's run under them (R3.3). */
export function timelineLines(blocks: ChatBlock[], steps: StepRow[], run: (stepId: string) => SpecialistEntry[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case "user":
        out.push(`› you: ${indent(b.text, "  ")}${b.read ? "" : " (not read yet)"}`)
        break
      case "agent":
        out.push(`● orchestrator: ${indent(b.text, "  ")}`)
        break
      case "tools": {
        const last = b.items.at(-1)!
        const failed = b.items.filter((i) => i.failed).length
        out.push(
          b.items.length === 1
            ? `  ⚙ ${last.name}${last.output === undefined ? " (running)" : last.failed ? " failed" : ` — ${oneLine(last.output, 100)}`}`
            : `  ⚙ ${b.items.length} tool calls${failed ? `, ${failed} failed` : ""} · last ${last.name}${last.output === undefined ? " (running)" : ""}`,
        )
        break
      }
      case "tool": {
        const step = stepOf(b, steps)
        if (!step) {
          out.push(`  ⚙ ${b.name}${b.output === undefined ? " (running)" : ""}`)
          break
        }
        out.push(`  ◆ specialist [${step.state}] ${oneLine(step.title)}`, ...runLines(run(step.id)))
        break
      }
      case "approval":
        break
      case "question":
        out.push(
          `? ${b.agent} asks: ${oneLine(b.question.prompt, 300)}${b.origin ? ` → ${String(b.answer)} (${b.origin === "user" ? "you" : b.origin})` : " (waiting for you)"}`,
        )
        break
      case "notice":
        out.push(`— ${b.text} —`)
        break
    }
  }
  return out
}

/** The question the task waits on, oldest first, with how to answer it (R3.4). */
export function waiting(items: ChatItem[]): QuestionItem | undefined {
  return pendingQuestions(items)[0]
}

export function questionLines(q: QuestionItem): string[] {
  const how =
    q.question.kind === "choice"
      ? (q.question.choices ?? []).map((c, i) => `  ${i + 1}. ${c}`)
      : [q.question.kind === "yesno" ? "  yes or no" : q.question.kind === "number" ? "  a number" : "  free text"]
  return [`${q.agent} asks: ${q.question.prompt}`, `  why: ${q.question.reason}`, ...how, `  default: ${String(q.question.default)}`]
}

/** An answer typed for a question, read as its kind calls for, or why it does not fit (R3.4). */
export function readAnswer(q: Question, text: string): { answer: Answer } | { error: string } {
  const t = text.trim()
  let value: Answer = t
  if (q.kind === "yesno") {
    if (/^(y|yes|true)$/i.test(t)) value = true
    else if (/^(n|no|false)$/i.test(t)) value = false
    else return { error: "Answer yes or no." }
  } else if (q.kind === "number") {
    if (!t || !Number.isFinite(Number(t))) return { error: "Answer with a number." }
    value = Number(t)
  } else if (q.kind === "choice") {
    const n = Number(t)
    const choices = q.choices ?? []
    value = Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : (choices.find((c) => c.toLowerCase() === t.toLowerCase()) ?? t)
  }
  try {
    return { answer: checkAnswer(q, value) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** A line starting with `/` is a command with its argument; anything else is text for the screen. */
export function readCommand(line: string): { command: string; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(line.trim())
  return m ? { command: m[1], arg: (m[2] ?? "").trim() } : null
}

/**
  Text from the target, the agents or a tool, made safe to draw: every control character but the newline removed, so
  nothing in it reaches the terminal as an escape sequence (a title, the clipboard, a cursor move).
*/
export function terminalSafe(text: string): string {
  return text.replace(CONTROL, "")
}
