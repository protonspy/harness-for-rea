import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
  The spike behind the TUI's runtime (plans/finish-the-harness 1.7): the core — node:sqlite, DeepAgents and LangGraph,
  the event log and a scripted delegation through the fake specialist — run under Bun, with the Electron-only parts
  left out. Needs Bun: HFR_BUN=1 npx vitest run tests/bun-core.test.ts (Bun on PATH, or fetched through npx).
*/

const ROOT = join(import.meta.dirname, "..")
const bun = (args: string[]) => {
  const onPath = spawnSync("bun", ["--version"], { encoding: "utf8", shell: process.platform === "win32" })
  const [cmd, pre] = onPath.status === 0 ? ["bun", []] : ["npx", ["-y", "bun@1.4.4"]]
  return spawnSync(cmd, [...pre, ...args], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: 240_000 })
}

describe.skipIf(!process.env.HFR_BUN)("the core under Bun (plans/finish-the-harness 1.7)", () => {
  it("runs a task with a delegation end to end on node:sqlite, DeepAgents and LangGraph", () => {
    // Bun reads the `@shared/*` alias from the root tsconfig.json and Vite's `?raw` imports on its own.
    const r = bun(["tests/fixtures/bun-core.ts"])
    const line = r.stdout.trim().split("\n").at(-1) ?? ""
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    const out = JSON.parse(line)
    expect(out.runtime).toMatch(/^bun /)
    expect(out.state).toBe("awaiting-user")
    expect(out.kinds).toEqual(expect.arrayContaining(["task.started", "model.call", "sandbox.copy", "specialist.result", "turn.done"]))
    expect(out.delegation).toBe("done")
  }, 300_000)
})
