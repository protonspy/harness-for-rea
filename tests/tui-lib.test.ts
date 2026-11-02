import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { StepRow } from "../src/shared/types"
import { completions, fuzzyScore, readCommand, search, type Command } from "../tui/src/app/commands"
import { keyLabel, keyOf, Keymap } from "../tui/src/app/keymap"
import { DARK, LIGHT, themeFor, toneColor } from "../tui/src/app/theme"
import { PromptHistory } from "../tui/src/lib/history"
import { parseMarkdown, plainOf } from "../tui/src/lib/markdown"
import { insertMention, mentionAt, suggestPaths } from "../tui/src/lib/mentions"
import { actionsFor, argSummary, callState, delegationSections, elapsed, toolDetails, toolLine, workingLine } from "../tui/src/lib/transcript"

describe("the key map (specs/tui-shell R2.1)", () => {
  it("names keys with their modifiers, and a typed symbol by its character", () => {
    expect(keyOf({ name: "p", ctrl: true })).toBe("ctrl+p")
    expect(keyOf({ name: "/", shift: true, sequence: "?" })).toBe("?")
    expect(keyOf({ name: "escape", sequence: "\u001b" })).toBe("escape")
    expect(keyOf({ name: "return", shift: true })).toBe("shift+return")
    expect(keyLabel("ctrl+p")).toBe("Ctrl+P")
    expect(keyLabel("escape")).toBe("Esc")
    expect(keyLabel("?")).toBe("?")
  })

  it("sends a key to the topmost layer binding it, stops at a modal layer, and lists what is reachable", () => {
    const map = new Keymap()
    const ran: string[] = []
    map.push({
      id: "global",
      title: "Everywhere",
      bindings: [
        { key: "ctrl+p", label: "Commands", run: () => void ran.push("palette") },
        { key: "escape", label: "Back", run: () => void ran.push("back") },
      ],
    })
    // a dialog's list is pushed before the dialog itself, as React runs a child's effects first: same height, still reached
    const list = map.push({ id: "list", title: "List", z: 1, bindings: [{ key: "down", label: "Next", run: () => void ran.push("next") }] })
    const off = map.push({ id: "dialog", title: "Dialog", z: 1, modal: true, bindings: [{ key: "escape", label: "Close", run: () => void ran.push("close") }] })
    expect(map.dispatch({ name: "down" })).toBe(true)
    ran.length = 0
    expect(map.dispatch({ name: "escape" })).toBe(true)
    expect(map.dispatch({ name: "p", ctrl: true })).toBe(false)
    expect(map.modal).toBe(true)
    expect(map.active().map((l) => l.title)).toEqual(["Dialog", "List"])
    off()
    list()
    map.dispatch({ name: "escape" })
    map.dispatch({ name: "p", ctrl: true })
    expect(ran).toEqual(["close", "back", "palette"])
    expect(map.active()[0].bindings.map((b) => b.key)).toEqual(["ctrl+p", "escape"])
  })
})

describe("slash commands and the palette (specs/tui-shell R2.2, R2.3)", () => {
  const cmd = (name: string, title: string): Command => ({ name, title, run: () => undefined })
  const all = [cmd("continue", "Continue the task"), cmd("close", "Close the task"), cmd("delete-task", "Delete the task"), cmd("help", "Keys")]

  it("reads a command and its argument, and leaves a message alone", () => {
    expect(readCommand("/key sk-or-1234")).toEqual({ name: "key", arg: "sk-or-1234" })
    expect(readCommand("  /done ")).toEqual({ name: "done", arg: "" })
    expect(readCommand("explain /usr/bin")).toBeNull()
  })

  it("completes the name being typed after /, and nothing once an argument follows", () => {
    expect(completions(all, "/c").map((c) => c.name)).toEqual(["close", "continue"])
    expect(completions(all, "/").length).toBe(4)
    expect(completions(all, "/close now")).toEqual([])
    expect(completions(all, "hello")).toEqual([])
  })

  it("finds commands by letters in order, best first", () => {
    expect(fuzzyScore("dt", "delete-task")).toBeGreaterThan(0)
    expect(fuzzyScore("xyz", "delete-task")).toBe(-1)
    expect(search(all, "del")[0].name).toBe("delete-task")
    expect(search(all, "keys").map((c) => c.name)).toEqual(["help"])
    expect(search(all, "").length).toBe(4)
  })
})

describe("the theme (specs/tui-shell R1.3)", () => {
  it("is the desktop app's dark colors by default, light on request", () => {
    expect(themeFor(null, {})).toBe(DARK)
    expect(themeFor(null, { HFR_THEME: "light" })).toBe(LIGHT)
    expect(themeFor("dark", { HFR_THEME: "light" })).toBe(DARK)
    expect(DARK.background).toBe("#0b0d10")
    expect(DARK.primary).toBe("#7aa2f7")
    expect(toneColor(DARK, "bad")).toBe(DARK.destructive)
  })
})

describe("the prompt's history (specs/tui-conversation R4.2)", () => {
  it("walks back through what was sent and forward to the draft again", () => {
    const h = new PromptHistory()
    h.add("first")
    h.add("second")
    h.add("second")
    expect(h.size).toBe(2)
    expect(h.prev("draft")).toBe("second")
    expect(h.prev("second")).toBe("first")
    expect(h.prev("first")).toBeNull()
    expect(h.next()).toBe("second")
    expect(h.next()).toBe("draft")
    expect(h.next()).toBeNull()
  })
})

describe("@ mentions (specs/tui-conversation R4.3)", () => {
  it("finds the mention under the cursor, and puts the chosen path in its place", () => {
    expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" })
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" })
    expect(mentionAt("mail me@host", 12)).toBeNull()
    expect(mentionAt("look at it", 10)).toBeNull()
    const m = mentionAt("see @ma please", 7)!
    expect(insertMention("see @ma please", m, "src/main.c")).toEqual({ text: "see @src/main.c  please", cursor: 16 })
  })

  it("completes from the target's files, skipping dependency and VCS folders", () => {
    const root = mkdtempSync(join(tmpdir(), "hfr-mention-"))
    mkdirSync(join(root, "src", "net"), { recursive: true })
    mkdirSync(join(root, "node_modules", "x"), { recursive: true })
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "src", "main.c"), "")
    writeFileSync(join(root, "src", "net", "proto.c"), "")
    writeFileSync(join(root, "node_modules", "x", "main.js"), "")
    writeFileSync(join(root, "README.md"), "")
    expect(suggestPaths(root, "")).toEqual(expect.arrayContaining(["src/", "README.md"]))
    expect(suggestPaths(root, "")).not.toContain("node_modules/")
    expect(suggestPaths(root, "main")[0]).toBe("src/main.c")
    expect(suggestPaths(root, "src/n").slice(0, 2)).toEqual(["src/net/", "src/net/proto.c"])
    expect(suggestPaths(root, "zzz")).toEqual([])
  })
})

describe("markdown as the TUI draws it (specs/tui-conversation R1.2)", () => {
  it("keeps headings, styled runs, lists with their markers, code with its language, tables and rules", () => {
    const blocks = parseMarkdown(
      "# Title\n\nSome **bold**, *it*, ~~gone~~ and `code` [site](https://x.dev).\n\n- one\n  - nested\n- [x] done\n\n1. first\n\n> quoted\n\n```ts\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n![pic](p.png) <b>raw</b>",
    )
    expect(blocks[0]).toMatchObject({ kind: "heading", depth: 1 })
    const para = blocks[1]
    expect(para.kind).toBe("para")
    if (para.kind !== "para") return
    expect(para.runs).toEqual(
      expect.arrayContaining([
        { text: "bold", bold: true },
        { text: "it", italic: true },
        { text: "gone", strike: true },
        { text: "code", code: true },
        { text: "site", link: "https://x.dev" },
      ]),
    )
    expect(plainOf(para.runs)).toBe("Some bold, it, gone and code site (https://x.dev).")
    const items = blocks.filter((b) => b.kind === "para" && b.marker)
    expect(items.map((b) => b.kind === "para" && [b.marker, b.indent, plainOf(b.runs)])).toEqual([
      ["• ", 0, "one"],
      ["• ", 1, "nested"],
      ["[x] ", 0, "done"],
      ["1. ", 0, "first"],
    ])
    expect(blocks.find((b) => b.kind === "para" && b.quote === 1)).toBeTruthy()
    expect(blocks.find((b) => b.kind === "code")).toMatchObject({ lang: "ts", text: "const x = 1" })
    const table = blocks.find((b) => b.kind === "table")
    expect(table?.kind === "table" && table.rows.map((r) => r.map(plainOf))).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(blocks.some((b) => b.kind === "rule")).toBe(true)
    const last = blocks.at(-1)
    expect(last?.kind === "para" && plainOf(last.runs)).toBe("[image: pic] <b>raw</b>")
  })
})

describe("the transcript's text (specs/tui-conversation R1.3, R1.4, R2.1, R2.2)", () => {
  const tool = (o: Partial<{ name: string; input: string; output: string; failed: boolean }>) => ({
    kind: "tool" as const,
    id: "t",
    at: 0,
    name: "read_file",
    input: "{}",
    failed: false,
    ...o,
  })

  it("shows a call on one line by its telling argument, and its state", () => {
    expect(toolLine(tool({ input: JSON.stringify({ file_path: "/workspace/a.c", limit: 10 }) }))).toBe("read_file(/workspace/a.c)")
    expect(toolLine(tool({ name: "execute", input: JSON.stringify({ command: "ls -la\n  /scratch" }) }))).toBe("execute(ls -la /scratch)")
    expect(toolLine(tool({ name: "write_todos", input: JSON.stringify({ todos: [] }) }))).toBe("write_todos")
    expect(argSummary("not json at all")).toBe("not json at all")
    expect(argSummary(JSON.stringify({ path: "x".repeat(200) })).length).toBe(80)
    expect(callState(tool({}))).toBe("running")
    expect(callState(tool({ output: "ok" }))).toBe("done")
    expect(callState(tool({ output: "no", failed: true }))).toBe("failed")
  })

  it("opens a call to its arguments and output, cut to a screenful", () => {
    const d = toolDetails(tool({ input: '{"a":1}', output: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") }), 10)
    expect(d.input).toBe('{\n  "a": 1\n}')
    expect(d.output.split("\n")).toHaveLength(11)
    expect(d.output).toContain("… 40 more lines")
  })

  it("opens a delegation to its package, report, evidence and files", () => {
    const step = {
      id: "s",
      data: {
        context: {
          brief: "b",
          objective: "Map it",
          mode: "read",
          files: ["a.c"],
          questions: ["q1"],
          constraints: [],
          environment: [],
          excerpts: [{ path: "a.c", startLine: 1, endLine: 3 }],
        },
        report: "Found it",
        evidence: [{ path: "a.c", startLine: 1, endLine: 2, claim: "here" }],
      },
    } as unknown as StepRow
    const s = delegationSections(step, { copy: ["a.c"], read: ["a.c"], write: [], apply: [] })
    expect(s.map((x) => x.title)).toEqual(["Context package", "Report", "Evidence (1)", "Files"])
    expect(s[0].lines).toEqual(expect.arrayContaining(["Objective: Map it", "Questions:", "  • q1", "  a.c:1-3"]))
    expect(s[2].lines).toEqual(["a.c:1-2 — here"])
    expect(s[3].lines).toEqual(["copy: a.c", "read: a.c"])
    expect(delegationSections({ id: "x", data: { error: "boom" } } as unknown as StepRow, { copy: [], read: [], write: [], apply: [] })).toEqual([
      { title: "Error", lines: ["boom"] },
    ])
  })

  it("says how long a turn works and what the task spent", () => {
    expect(elapsed(42_000)).toBe("42s")
    expect(elapsed(65_000)).toBe("1m 05s")
    expect(elapsed(3_720_000)).toBe("1h 02m")
    expect(workingLine({ tokensIn: 12_000, tokensOut: 345, costUsd: 0.03, specialistCostUsd: 0.01 }, "running", 0, 83_000)).toBe(
      "Working · 1m 23s · 12k tokens · $0.04",
    )
    expect(workingLine({ tokensIn: 0, tokensOut: 0, costUsd: 0, specialistCostUsd: 0 }, "pending", 0, 0)).toBe("Starting the sandbox · 0s · 0 tokens · $0.00")
  })

  it("offers each action only in the states where it applies", () => {
    expect(actionsFor("running")).toEqual(["stop", "cancel"])
    expect(actionsFor("stopped")).toEqual(["continue", "close", "delete"])
    expect(actionsFor("awaiting-user")).toEqual(["close", "delete"])
    expect(actionsFor("failed")).toEqual(["continue", "retry", "delete"])
    expect(actionsFor("done")).toEqual(["continue", "delete"])
  })
})
