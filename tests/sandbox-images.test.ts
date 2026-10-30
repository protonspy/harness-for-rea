import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { contextHash } from "../scripts/context-hash.mjs"
import pins from "../sandbox/images.json"

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

describe("the base image pin (specs/sandbox-images R1.3, R1.4)", () => {
  it("is a GHCR digest published from the current build context", () => {
    const { ref, context: hash } = pins.specialistBase
    expect(ref).toMatch(/^ghcr\.io\/[a-z0-9-]+\/hfr-specialist-base@sha256:[0-9a-f]{64}$/)
    // A changed context fails here until the Images workflow publishes it and `npm run pin-images` re-pins.
    expect(contextHash(join(import.meta.dirname, "..", "sandbox", "specialist-base"))).toBe(hash)
  })
})
