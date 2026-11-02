import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { closeDb, getDb, openDb } from "../src/main/db"
import { keyringStore } from "../src/main/keys"

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

/** Bun, run without waiting, so two apps start together. */
const bunAsync = (args: string[]) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const onPath = spawnSync("bun", ["--version"], { encoding: "utf8", shell: process.platform === "win32" })
    const [cmd, pre] = onPath.status === 0 ? ["bun", []] : ["npx", ["-y", "bun@1.4.4"]]
    const p = spawn(cmd, [...pre, ...args], { cwd: ROOT, shell: process.platform === "win32" })
    let out = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (out += d))
    p.on("close", (code) => resolve({ code, out }))
  })

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

  it("keeps provider keys in one keychain store the desktop app reads too, moving the 0.1 TUI's keys into it (specs/shared-data-folder R5)", async () => {
    const service = `harness-for-rea-test-${process.pid}`
    const r = bun(["tests/fixtures/bun-keys.ts", service])
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      available: true,
      moved: 1,
      movedKey: "sk-deepseek-formerstore01",
      leftInFormer: null,
      afterRestart: "sk-or-v1-keychaintest0001",
      inDb: false,
      inKeychain: "sk-or-v1-keychaintest0001",
      afterClear: null,
    })
    // What the TUI saved under Bun, read by Node as the desktop app reads it, then removed.
    const store = keyringStore(service)
    expect(await store.read("openrouter.key")).toBe("sk-or-v1-savedbythetui01")
    await store.write("openrouter.key", null)
    await store.write("deepseek.key", null)
  }, 120_000)

  it("migrates once, gives old tasks one project per source folder and builds the image once, with two apps started together (specs/shared-data-folder R3.2, R4.1, R4.2)", async () => {
    const both = async (dataDir: string) => {
      const run = (app: string) => bunAsync(["tests/fixtures/bun-two-apps.ts", dataDir, app])
      const outs = await Promise.all([run("desktop"), run("tui")])
      for (const o of outs) expect(o.code, o.out).toBe(0)
      return outs.map((o) => JSON.parse(o.out.trim().split("\n").at(-1) ?? "") as { adopted: number; built: boolean })
    }
    // a fresh data folder: one migration between them, one build
    const fresh = mkdtempSync(join(tmpdir(), "hfr-two-"))
    const first = await both(fresh)
    expect(first.filter((o) => o.built)).toHaveLength(1)
    expect(readFileSync(join(fresh, "builds.log"), "utf8").trim().split("\n")).toHaveLength(1)

    // a data folder holding tasks from before projects
    const old = mkdtempSync(join(tmpdir(), "hfr-two-"))
    openDb(join(old, "hfr.db"))
    for (const [i, root] of ["C:/a", "C:/b", "C:/a"].entries())
      getDb()
        .prepare("INSERT INTO tasks (id, request, source_root, model, state, created_at, updated_at) VALUES (?, 'r', ?, 'm', 'done', ?, ?)")
        .run(`00000000-0000-4000-8000-00000000000${i}`, root, i, i)
    closeDb()
    const second = await both(old)
    expect(second.map((o) => o.adopted).sort()).toEqual([0, 2])
    openDb(join(old, "hfr.db"))
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n).toBe(2)
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id IS NULL").get() as { n: number }).n).toBe(0)
    closeDb()
  }, 240_000)
})
