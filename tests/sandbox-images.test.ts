import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contextHash } from "../scripts/context-hash.mjs"

function context(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hfr-ctx-"))
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  return dir
}

describe("the build context hash (specs/sandbox-images R1.1)", () => {
  it("is the same for a Windows checkout and a Linux one", () => {
    expect(contextHash(context({ Dockerfile: "FROM x\r\nRUN y\r\n" }))).toBe(contextHash(context({ Dockerfile: "FROM x\nRUN y\n" })))
  })

  it("changes when a file's content, name or presence changes", () => {
    const base = contextHash(context({ Dockerfile: "FROM x\n", "a/b.mjs": "1" }))
    expect(contextHash(context({ Dockerfile: "FROM x\n", "a/b.mjs": "2" }))).not.toBe(base)
    expect(contextHash(context({ Dockerfile: "FROM x\n", "a/c.mjs": "1" }))).not.toBe(base)
    expect(contextHash(context({ Dockerfile: "FROM x\n" }))).not.toBe(base)
  })

  it("does not depend on the order files were written in", () => {
    expect(contextHash(context({ b: "2", a: "1" }))).toBe(contextHash(context({ a: "1", b: "2" })))
  })
})
