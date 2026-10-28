import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { PathRejected, resolveRequested, resolveTarget } from "../src/main/sandbox/paths"

/* specs/task-sandbox R1.3: a requested path never leaves the source root. */

const base = mkdtempSync(join(tmpdir(), "hfr-paths-"))
const root = join(base, "repo")
const outside = join(base, "outside")
let symlinks = true

beforeAll(() => {
  mkdirSync(join(root, "src", "deep"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "a")
  writeFileSync(join(root, "src", "deep", "b.ts"), "b")
  writeFileSync(join(outside, "secret.txt"), "s")
  symlinkSync(outside, join(root, "junction"), "junction")
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"), "file")
  } catch {
    symlinks = false
  }
})

const rejected = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(PathRejected)
    return (e as PathRejected).path
  }
  throw new Error("expected the path to be rejected")
}

describe("resolveRequested", () => {
  it("resolves a file inside the root to its normalized relative path", () => {
    expect(resolveRequested(root, "src/a.ts")).toEqual({ rel: "src/a.ts", abs: join(root, "src", "a.ts") })
    expect(resolveRequested(root, "src\\deep\\b.ts").rel).toBe("src/deep/b.ts")
    expect(resolveRequested(root, "./src/a.ts").rel).toBe("src/a.ts")
  })

  it("rejects `..` anywhere, even when it would land back inside", () => {
    expect(rejected(() => resolveRequested(root, "../outside/secret.txt"))).toBe("../outside/secret.txt")
    rejected(() => resolveRequested(root, "src/../src/a.ts"))
    rejected(() => resolveRequested(root, "src/..\\..\\outside"))
  })

  it("rejects absolute, drive-relative and UNC paths", () => {
    rejected(() => resolveRequested(root, join(root, "src", "a.ts")))
    rejected(() => resolveRequested(root, "/etc/passwd"))
    rejected(() => resolveRequested(root, "C:secret.txt"))
    rejected(() => resolveRequested(root, "\\\\server\\share\\x"))
  })

  it("rejects a path through a junction", () => {
    rejected(() => resolveRequested(root, "junction/secret.txt"))
  })

  it("rejects a symbolic link", () => {
    if (!symlinks) return
    rejected(() => resolveRequested(root, "link.txt"))
  })

  it("rejects what is not a regular file, and what does not exist", () => {
    rejected(() => resolveRequested(root, "src"))
    rejected(() => resolveRequested(root, "src/missing.ts"))
    rejected(() => resolveRequested(root, ""))
    rejected(() => resolveRequested(root, "a\0b"))
  })
})

describe("resolveTarget", () => {
  it("allows a new file under an existing directory inside the root", () => {
    expect(resolveTarget(root, "src/new/c.ts").rel).toBe("src/new/c.ts")
  })

  it("rejects a target through a junction or outside the root", () => {
    rejected(() => resolveTarget(root, "junction/new.txt"))
    rejected(() => resolveTarget(root, "../x"))
  })
})
