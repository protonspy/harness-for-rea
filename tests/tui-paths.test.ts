import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseArgs, sandboxDirFor } from "../tui/src/paths"

/* specs/release R1.3, R1.4, R2.4: the CLI's flags and where it finds the sandbox sources. */

const has =
  (...dirs: string[]) =>
  (p: string) =>
    dirs.some((d) => p === join(d, "specialist", "Dockerfile"))

describe("the CLI's start (specs/release)", () => {
  it("answers --version and --help before anything starts, and runs the TUI otherwise (specs/tui-launch R2.5)", () => {
    expect(parseArgs(["--version"], "1.2.3")).toEqual({ print: "harness-for-rea 1.2.3", code: 0 })
    expect(parseArgs(["-h"], "1.2.3")).toMatchObject({ print: expect.stringMatching(/^Usage: harness-for-rea/), code: 0 })
    expect(parseArgs([], "1.2.3")).toEqual({ args: { path: null, continue: false, resume: false, theme: null } })
  })

  it("takes the target folder, continue or resume, and the theme, and refuses what it does not know (specs/tui-launch R1.1, R2.2, R2.3)", () => {
    expect(parseArgs(["C:/samples/app", "--continue"], "1")).toEqual({ args: { path: "C:/samples/app", continue: true, resume: false, theme: null } })
    expect(parseArgs(["-r", "--theme", "light"], "1")).toEqual({ args: { path: null, continue: false, resume: true, theme: "light" } })
    expect(parseArgs(["--theme=dark"], "1")).toMatchObject({ args: { theme: "dark" } })
    expect(parseArgs(["--theme", "blue"], "1")).toMatchObject({ code: 2, print: expect.stringContaining("--theme takes dark or light.") })
    expect(parseArgs(["--nope"], "1")).toMatchObject({ code: 2, print: expect.stringContaining("Unknown option --nope.") })
    expect(parseArgs(["a", "b"], "1")).toMatchObject({ code: 2 })
    expect(parseArgs(["-c", "-r"], "1")).toMatchObject({ code: 2, print: expect.stringContaining("not both") })
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
