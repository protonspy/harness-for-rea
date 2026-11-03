import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CLI_SANDBOX } from "../scripts/cli-sandbox"

/* specs/release R1.3: the CLI carries every part of sandbox/ the core reads at run time. */

const ROOT = join(import.meta.dirname, "..")

/** The folders of sandbox/ the core joins onto its sandbox folder, read from the source that joins them. */
function partsRead(): string[] {
  const out = new Set<string>()
  for (const file of ["src/main/core.ts", "src/main/sandbox/docker.ts"])
    for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/join\((?:host\.)?sandboxDir, "([^"]+)"/g)) out.add(m[1])
  return [...out].sort()
}

describe("the CLI's sandbox folder (R1.3)", () => {
  it("carries every part the core reads: the specialist's image, the integrations' MCP server, Cheat Engine's bridge and IDA Pro's plugin", () => {
    expect(partsRead()).toEqual(["cheat-engine", "ida-pro", "mcp", "specialist"])
    expect([...CLI_SANDBOX].sort()).toEqual(partsRead())
  })

  it("names parts that exist", () => {
    for (const part of CLI_SANDBOX) expect(existsSync(join(ROOT, "sandbox", part))).toBe(true)
  })
})
