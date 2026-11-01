import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { answerFlags, sandboxDirFor } from "../tui/src/paths"

/* specs/release R1.3, R1.4, R2.4: the CLI's flags and where it finds the sandbox sources. */

const has =
  (...dirs: string[]) =>
  (p: string) =>
    dirs.some((d) => p === join(d, "specialist", "Dockerfile"))

describe("the CLI's start (specs/release)", () => {
  it("answers --version and --help before anything starts, and runs the TUI otherwise", () => {
    expect(answerFlags(["--version"], "1.2.3")).toBe("harness-for-rea 1.2.3")
    expect(answerFlags(["-h"], "1.2.3")).toMatch(/^Usage: harness-for-rea/)
    expect(answerFlags([], "1.2.3")).toBeNull()
  })

  it("finds the sandbox sources named by the shim, beside a compiled binary, in the package, or in the repository", () => {
    const base = { execPath: join("/opt", "hfr", "harness-for-rea"), moduleDir: join("/pkg", "dist") }
    expect(sandboxDirFor({ ...base, env: { HFR_SANDBOX_DIR: "/named" }, exists: has("/named", join("/opt", "hfr", "sandbox")) })).toBe("/named")
    expect(sandboxDirFor({ ...base, env: {}, exists: has(join("/opt", "hfr", "sandbox")) })).toBe(join("/opt", "hfr", "sandbox"))
    expect(sandboxDirFor({ ...base, env: {}, exists: has(join("/pkg", "sandbox")) })).toBe(join("/pkg", "sandbox"))
    expect(sandboxDirFor({ ...base, moduleDir: join("/repo", "tui", "src"), env: {}, exists: has(join("/repo", "sandbox")) })).toBe(join("/repo", "sandbox"))
    expect(sandboxDirFor({ ...base, env: { HFR_SANDBOX_DIR: "/empty" }, exists: () => false })).toBeNull()
  })
})
