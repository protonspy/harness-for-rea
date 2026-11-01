import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ContractSchema } from "../src/shared/contract"
import { compare, replayCommand } from "../src/main/orchestrator/replay"

/* specs/vector-replay R2.2, R2.5: the replay line and the comparison. */

const vector = (o: Record<string, unknown>) => ContractSchema.parse({ vectors: [{ name: "v", stdout: "", source: "./t", ...o }] }).vectors[0]
const hostile = ["$(touch pwned)", "`id`", "a b", "it's", '"q"', "; exit 9", "\\"]

describe("the replay line (specs/vector-replay R2.5)", () => {
  it("carries arguments and standard input only as base64, never as shell text", () => {
    const line = replayCommand("python3 /scratch/impl.py", vector({ args: hostile, stdin: "$(reboot)\n" }))
    for (const a of [...hostile, "$(reboot)"]) expect(line).not.toContain(a)
    expect(line.startsWith("printf %s '")).toBe(true)
    expect(line).toContain("| base64 -d | python3 /scratch/impl.py ")
    expect(line.endsWith(" 2>/dev/null")).toBe(true)
  })

  const shell = spawnSync("sh", ["-c", "command -v base64"], { encoding: "utf8" })
  it.skipIf(shell.status !== 0)("runs in a POSIX shell, handing the command each argument and the input exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "hfr-replay-"))
    const echo = join(dir, "echo.cjs").replace(/\\/g, "/")
    writeFileSync(
      echo,
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s}));process.exit(3)})",
    )
    const node = process.execPath.replace(/\\/g, "/")
    const r = spawnSync("sh", ["-c", replayCommand(`"${node}" "${echo}"`, vector({ args: hostile, stdin: "line 1\n$(x)\n" }))], { cwd: dir, encoding: "utf8" })
    expect(JSON.parse(r.stdout)).toEqual({ args: hostile, stdin: "line 1\n$(x)\n" })
    expect(r.status).toBe(3)
  })
})

describe("comparing a replay with its vector (specs/vector-replay R2.2)", () => {
  it("passes when standard output and the exit code match byte for byte", () => {
    expect(compare(vector({ stdout: "a\nb\n", exitCode: 0 }), "a\nb\n", 0)).toEqual({ name: "v", pass: true })
  })

  it("says what differed: the output, the exit code, or both", () => {
    expect(compare(vector({ stdout: "a\n" }), "a", 0)).toEqual({ name: "v", pass: false, stdout: { expected: "a\n", got: "a" } })
    expect(compare(vector({ stdout: "", exitCode: 2 }), "", 0)).toEqual({ name: "v", pass: false, exitCode: { expected: 2, got: 0 } })
    expect(compare(vector({ stdout: "x".repeat(5000) }), "y", 1)).toMatchObject({
      pass: false,
      stdout: { expected: expect.stringMatching(/…$/) },
      exitCode: { expected: 0, got: 1 },
    })
  })
})
