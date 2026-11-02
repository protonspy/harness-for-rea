import { RGBA } from "@opentui/core"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYNTAX } from "../../src/renderer/src/lib/highlight"
import { conversation, event, history, pushBus, render, scriptedApi, task, type Screen } from "./support"

/* specs/tui-conversation: a task as a conversation at parity with the desktop timeline. */

let s: Screen | null = null
afterEach(async () => {
  await s?.dispose()
  s = null
})
const ID = task().id
const open = async (script: Parameters<typeof scriptedApi>[0] = {}, bus = pushBus()) => {
  const api = scriptedApi(script)
  s = await render({ api: api.api, bus: bus.bus, start: { kind: "task", id: ID } })
  await s.until(`[${script.getTask ? "" : "awaiting-user"}`)
  return { ...api, push: bus.push, s }
}

/** The color a piece of text is drawn in, from the frame's spans. */
function colorOf(sc: Screen, text: string): string | null {
  for (const line of sc.captureSpans().lines) for (const span of line.spans) if (span.text.includes(text)) return span.fg.toString()
  return null
}

describe("the transcript (specs/tui-conversation R1)", () => {
  test("draws the agent's markdown, its code colored by the shared highlighter (R1.2)", async () => {
    const { s } = await open()
    await s.until("Here is what I found:")
    expect(s.frame()).not.toContain("**what**")
    expect(s.frame()).toContain("int main(void) { return 0; }")
    expect(colorOf(s, "int")).toBe(RGBA.fromHex(SYNTAX.typeName).toString())
    expect(colorOf(s, "return")).toBe(RGBA.fromHex(SYNTAX.keyword).toString())
  })

  test("shows tool calls on one line, expanded from the start, folded and unfolded with Ctrl+O and Enter (R1.3)", async () => {
    const { s } = await open()
    await s.until("✓ read_file(/workspace/src/main.c)")
    expect(s.frame()).toContain('"file_path": "/workspace/src/main.c"')
    await s.press("o", { ctrl: true })
    await s.until(() => !s.frame().includes('"file_path"'))
    expect(s.frame()).toContain("✓ read_file(/workspace/src/main.c)")
    // into the transcript, pick the call, unfold it alone
    await s.press("tab")
    await s.press("up")
    await s.press("return")
    await s.until('"file_path": "/workspace/src/main.c"')
  })

  test("shows a delegation with its package, report, evidence and the specialist's run, a running tool with its time (R1.4)", async () => {
    const { s } = await open()
    await s.until("◆ specialist [done] Map the parser")
    const f = s.frame()
    for (const part of [
      "Context package",
      "Objective: Map the parser",
      "Where is the header read?",
      "Report",
      "The header is read in parse_header.",
      "Evidence (1)",
      "src/main.c:3-9 — the header is read here",
      "Specialist's run (2)",
      "∴ The header comes first.",
      "⚙ Bash make  running · 30s",
    ])
      expect(f).toContain(part)
  })

  test("adds what is pushed to the end (R1.1)", async () => {
    const { s, push } = await open()
    await s.until("Here is what I found:")
    push({ type: "event", event: event("message.agent", { output: "A **new** finding." }) })
    await s.until("A new finding.")
  })
})

describe("turns (specs/tui-conversation R2)", () => {
  test("shows the working line with elapsed time, tokens and cost, and Esc stops the turn (R2.1, R2.2)", async () => {
    const { s, called } = await open({ getTask: () => history({ task: task({ state: "running" }) }) })
    await s.until("esc to stop")
    expect(s.frame()).toMatch(/Working · \d+s · 1\.5k tokens · \$0\.07/)
    await s.press("escape")
    await s.until(() => called("stopTurn").length === 1)
  })

  test("asks before deleting a task, and deletes it on yes (R2.3)", async () => {
    const { s, called } = await open()
    await s.until("Here is what I found:")
    await s.type("/delete")
    await s.enter()
    await s.until("Delete this task with its history, files and containers?")
    expect(called("deleteTask")).toHaveLength(0)
    await s.press("y")
    await s.until(() => called("deleteTask").length === 1)
  })

  test("offers only the actions the state allows", async () => {
    const { s } = await open({ getTask: () => history({ task: task({ state: "failed" }) }) })
    await s.type("/")
    await s.until("/continue")
    await s.type("st")
    await s.until("/start-over")
    expect(s.frame()).not.toContain("/stop ")
  })
})

describe("decisions (specs/tui-conversation R3)", () => {
  test("answers a question from a dialog of its choices (R3.3)", async () => {
    const asked = conversation()
    asked.events.push(
      event("question.asked", {
        questionId: "q1",
        question: { prompt: "Which build?", reason: "They differ.", kind: "choice", choices: ["debug", "release"], default: "release" },
      }),
    )
    const { s, called } = await open({ getTask: () => history({ ...asked, task: task({ state: "waiting" }) }) })
    await s.until("Which build?")
    await s.until("Why: They differ.")
    await s.press("up")
    await s.enter()
    await s.until(() => called("answerQuestion").length === 1)
    expect(called("answerQuestion")[0].args).toEqual([ID, "q1", "debug"])
  })

  test("approves a gated call from its dialog (R3.2)", async () => {
    const gated = conversation()
    gated.events.push(event("approval.requested", { calls: [{ callId: "g1", name: "execute", args: { command: "rm -rf build" } }] }))
    const { s, called } = await open({ getTask: () => history({ ...gated, task: task({ state: "waiting" }) }) })
    await s.until("The agent wants to run execute")
    expect(s.frame()).toContain("rm -rf build")
    await s.enter()
    await s.until(() => called("decideTool").length === 1)
    expect(called("decideTool")[0].args).toEqual([ID, "g1", { type: "approve" }])
  })

  test("shows a proposed patch as a diff, applied with /approve-patch (R3.1)", async () => {
    const patch = {
      id: "00000000-0000-4000-8000-000000000099",
      taskId: ID,
      stepId: "s1",
      state: "proposed" as const,
      files: [{ path: "src/a.c", op: "modify" }],
      diff: "--- a/src/a.c\n+++ b/src/a.c\n@@ -1 +1 @@\n-int a = 1;\n+int a = 2;\n",
      conflicts: [],
      createdAt: 1,
    }
    const { s, called } = await open({ getTask: () => history({ patches: [patch as never] }) })
    await s.until("Patch proposed · 1 file(s)")
    expect(s.frame()).toContain("+int a = 2;")
    await s.type("/approve-patch")
    await s.enter()
    await s.until(() => called("decidePatch").length === 1)
    expect(called("decidePatch")[0].args).toEqual([ID, patch.id, "approve"])
  })
})

describe("the prompt (specs/tui-conversation R4)", () => {
  test("sends a message, keeps it in the history, and takes Ctrl+J as a new line (R4.1, R4.2, R4.4)", async () => {
    const { s, called } = await open()
    await s.type("first line")
    await s.press("j", { ctrl: true })
    await s.type("second line")
    await s.enter()
    await s.until(() => called("sendMessage").length === 1)
    expect(called("sendMessage")[0].args).toEqual([ID, "first line\nsecond line"])
    await s.press("up")
    await s.until("second line")
  })

  test("completes an @ path from the project's target folder (R4.3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hfr-at-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "main.c"), "")
    const { s } = await open({ getTask: () => history({ task: task({ sourceRoot: root }) }) })
    await s.type("look at @mai")
    await s.until("@src/main.c")
    await s.press("tab")
    await s.until("look at @src/main.c")
  })
})

describe("the sidebar (specs/tui-panels R1.1)", () => {
  test("shows the plan, the delegations, the usage per agent with the estimate marked, toggled with Ctrl+B", async () => {
    const { s } = await open()
    await s.until("Usage")
    for (const part of ["✓ Read the parser", "▸ Write the client", "Specialist (1)", "~$0.05", "Total        $0.07"]) expect(s.frame()).toContain(part)
    await s.press("b", { ctrl: true })
    await s.until(() => !s.frame().includes("Total        $0.07"))
  })
})
