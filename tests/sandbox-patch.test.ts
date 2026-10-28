import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { applyPatch, conflictsOf, discardPatch, makePatch, PatchConflict, patchDir } from "../src/main/sandbox/patch"
import { prepareWorkspace } from "../src/main/sandbox/workspace"

/* specs/task-sandbox R4.1–R4.3: a patch from the workspace, applied only when the originals are unchanged. */

let base = ""
let root = ""
let data = ""

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-patch-"))
  root = join(base, "repo")
  data = join(base, "data")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n")
  writeFileSync(join(root, "src", "b.ts"), "keep\n")
  writeFileSync(join(root, "src", "gone.ts"), "bye\n")
})

function proposed() {
  const ws = prepareWorkspace(data, root, ["src/a.ts", "src/b.ts", "src/gone.ts"])
  writeFileSync(join(ws.workspace, "src", "a.ts"), "one\nTWO\nthree\n")
  writeFileSync(join(ws.workspace, "src", "new.ts"), "fresh\n")
  unlinkSync(join(ws.workspace, "src", "gone.ts"))
  const p = makePatch(data, ws)
  if (!p) throw new Error("expected a patch")
  return { ws, p }
}

describe("makePatch (R4.1)", () => {
  it("lists modified, added and deleted files with a readable diff", () => {
    const { p } = proposed()
    expect(p.files).toEqual([
      { path: "src/a.ts", status: "modified", added: 1, removed: 1 },
      { path: "src/new.ts", status: "added", added: 1, removed: 0 },
      { path: "src/gone.ts", status: "deleted", added: 0, removed: 1 },
    ])
    expect(p.diff).toContain("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three")
    expect(p.diff).toContain("--- /dev/null\n+++ b/src/new.ts")
    expect(p.diff).toContain("+++ /dev/null")
  })

  it("proposes nothing when the workspace is unchanged", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    expect(makePatch(data, ws)).toBeNull()
  })

  it("marks binary files instead of diffing them", () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]))
    const ws = prepareWorkspace(data, root, ["bin.dat"])
    writeFileSync(join(ws.workspace, "bin.dat"), Buffer.from([1, 0, 3]))
    expect(makePatch(data, ws)!.diff).toContain("Binary file modified")
  })
})

describe("applyPatch (R4.2, R4.3)", () => {
  it("writes the approved changes to the originals", () => {
    const { p } = proposed()
    expect(applyPatch(data, p.id, root)).toEqual(["src/a.ts", "src/new.ts", "src/gone.ts"])
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("one\nTWO\nthree\n")
    expect(readFileSync(join(root, "src", "new.ts"), "utf8")).toBe("fresh\n")
    expect(existsSync(join(root, "src", "gone.ts"))).toBe(false)
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("keep\n")
  })

  it("still applies after the workspace was discarded", () => {
    const { ws, p } = proposed()
    rmSync(ws.workspace, { recursive: true })
    rmSync(ws.snapshot, { recursive: true })
    applyPatch(data, p.id, root)
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("one\nTWO\nthree\n")
  })

  it("refuses the whole patch, changing nothing, when an original changed since copy", () => {
    const { p } = proposed()
    writeFileSync(join(root, "src", "a.ts"), "edited by the user\n")
    expect(conflictsOf(data, p.id, root)).toEqual(["src/a.ts"])
    let err: unknown
    try {
      applyPatch(data, p.id, root)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PatchConflict)
    expect((err as PatchConflict).conflicts).toEqual(["src/a.ts"])
    expect(existsSync(join(root, "src", "new.ts"))).toBe(false)
    expect(existsSync(join(root, "src", "gone.ts"))).toBe(true)
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("edited by the user\n")
  })

  it("refuses when a file the specialist added now exists in the original tree", () => {
    const { p } = proposed()
    writeFileSync(join(root, "src", "new.ts"), "someone else's\n")
    expect(() => applyPatch(data, p.id, root)).toThrow(PatchConflict)
    expect(readFileSync(join(root, "src", "new.ts"), "utf8")).toBe("someone else's\n")
  })

  it("refuses when a deleted original was edited", () => {
    const { p } = proposed()
    writeFileSync(join(root, "src", "gone.ts"), "still here\n")
    expect(() => applyPatch(data, p.id, root)).toThrow(/src\/gone.ts/)
  })

  it("discards a patch's stored files", () => {
    const { p } = proposed()
    discardPatch(data, p.id)
    expect(existsSync(patchDir(data, p.id))).toBe(false)
  })
})
