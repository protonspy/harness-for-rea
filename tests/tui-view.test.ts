import { describe, expect, it } from "vitest"
import type { EventRow, ProjectRow, Readiness, StepRow } from "@shared/types"
import { blocks } from "../src/renderer/src/lib/chat"
import { Timeline } from "../src/renderer/src/lib/timeline"
import { terminalSafe, projectLabel, questionLines, readAnswer, readCommand, setupLines, timelineLines, waiting } from "../tui/src/view"

/* specs/tui R2.1, R3.1–R3.4: what the TUI's screens show, and how its input line is read. */

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
const step: StepRow = {
  id: "s1",
  taskId: "t",
  ord: 1,
  kind: "delegation",
  title: "Map the parser",
  agent: "specialist",
  state: "running",
  data: { callId: "c1" },
  createdAt: 0,
  updatedAt: 0,
}

describe("the TUI's lines (specs/tui)", () => {
  it("shows each setup step with its state and what readies it, and when the setup can be completed (R2.1)", () => {
    const r: Readiness = {
      sandbox: { ready: true, reason: "", building: false },
      claude: { ready: false, reason: "Sign in to Claude." },
      model: { ready: true, reason: "", provider: "openrouter", model: "deepseek/deepseek-v4" },
      ready: false,
      completed: false,
    }
    const lines = setupLines(r)
    expect(lines[0]).toBe("[x] Sandbox images")
    expect(lines[1]).toBe("[ ] Claude sign-in — Sign in to Claude.")
    expect(lines[2]).toBe("[x] Orchestrator — openrouter · deepseek/deepseek-v4")
    expect(lines.at(-1)).toMatch(/\/login signs Claude in/)
    expect(setupLines({ ...r, claude: { ready: true, reason: "", plan: "max" }, ready: true }).at(-1)).toMatch(/\/done completes the setup/)
  })

  it("labels a project by its name, goal, kind and model (R3.1)", () => {
    expect(projectLabel({ name: "codm", goal: "reimplement", targetKind: "android", model: "m" } as ProjectRow)).toBe("codm — reimplement, android · m")
  })

  it("shows the timeline: messages, tool runs, a delegation with the specialist's run under it, a question and a notice (R3.3)", () => {
    const t = new Timeline(
      [step],
      [
        ev("message.user", { output: "Find the bug" }, { agent: "app" }),
        ev("tool.call", { tool: "ls", callId: "a" }),
        ev("tool.result", { tool: "ls", callId: "a", output: "src\nlib" }),
        ev("tool.call", { tool: "delegate_to_specialist", callId: "c1" }),
        ev("specialist.tool.call", { tool: "Read", callId: "r1", input: "{}" }, { agent: "specialist", stepId: "s1", summary: "Read src/a.ts" }),
        ev(
          "question.asked",
          { questionId: "q1", question: { prompt: "UTF-8?", reason: "r", kind: "yesno", default: false } },
          { agent: "specialist", stepId: "s1" },
        ),
        ev("message.agent", { output: "Looking.\nStill looking." }),
        ev("turn.stopped", {}, { agent: "app", summary: "You stopped the turn" }),
      ],
      true,
    )
    expect(timelineLines(blocks(t.items), [step], (id) => t.run(id))).toEqual([
      "› you: Find the bug",
      "  ⚙ ls — src lib",
      "  ◆ specialist [running] Map the parser",
      "      · (running) Read src/a.ts",
      "? specialist asks: UTF-8? (waiting for you)",
      "● orchestrator: Looking.\n  Still looking.",
      "— You stopped the turn —",
    ])
    const q = waiting(t.items)!
    expect(q.id).toBe("q1")
    expect(questionLines(q)).toEqual(["specialist asks: UTF-8?", "  why: r", "  yes or no", "  default: false"])
  })

  it("reads an answer as its kind calls for, and says when it does not fit (R3.4)", () => {
    const choice = { prompt: "p", reason: "r", kind: "choice" as const, choices: ["Stop the task", "Skip this step"], default: "Skip this step" }
    expect(readAnswer(choice, "2")).toEqual({ answer: "Skip this step" })
    expect(readAnswer(choice, "stop the task")).toEqual({ answer: "Stop the task" })
    expect(readAnswer(choice, "9")).toMatchObject({ error: expect.stringContaining("does not fit") })
    const yesno = { prompt: "p", reason: "r", kind: "yesno" as const, default: false }
    expect(readAnswer(yesno, "Y")).toEqual({ answer: true })
    expect(readAnswer(yesno, "maybe")).toEqual({ error: "Answer yes or no." })
    expect(readAnswer({ prompt: "p", reason: "r", kind: "number", default: 1 }, "42")).toEqual({ answer: 42 })
    expect(readAnswer({ prompt: "p", reason: "r", kind: "number", default: 1 }, "x")).toEqual({ error: "Answer with a number." })
    expect(readAnswer({ prompt: "p", reason: "r", kind: "text", default: "" }, "  free  ")).toEqual({ answer: "free" })
  })

  it("draws no escape sequence that text from the target carries, keeping its newlines", () => {
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    expect(terminalSafe(`a${esc}]52;c;aGk=${bel}b${esc}[2Jc\nd`)).toBe("a]52;c;aGk=b[2Jc\nd")
  })

  it("reads a command and its argument from the input line, and anything else as text", () => {
    expect(readCommand("/key sk-or-v1-abc")).toEqual({ command: "key", arg: "sk-or-v1-abc" })
    expect(readCommand(" /back ")).toEqual({ command: "back", arg: "" })
    expect(readCommand("why is it slow?")).toBeNull()
  })
})
