import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import { closeDb, openDb } from "../src/main/db"
import { delegate, DelegationRefused, dockerLauncher, type Launcher } from "../src/main/delegation"
import { EventLog } from "../src/main/events/log"
import { claudeArgs, execArgs, stopArgs } from "../src/main/sandbox/docker"
import { SpecialistBoxes } from "../src/main/sandbox/specialistbox"
import type { BufferResult, ExecBuffer } from "../src/main/sandbox/taskbox"
import { askDir, readManifest, sha256 } from "../src/main/sandbox/workspace"

/* specs/specialist-sandbox R4: a delegation into a sandbox the orchestrator created. */

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs")

let base = ""
let root = ""
let data = ""
let fakeLog = ""
let log: EventLog
let taskId = ""
let layer = 0
let launches: { box?: string; cwd?: string }[] = []

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-dsbx-"))
  root = join(base, "repo")
  data = join(base, "data")
  fakeLog = join(base, "fake.jsonl")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2\n")
  openDb(join(data, "hfr.db"))
  log = new EventLog(data)
  taskId = log.createTask({ request: "r", sourceRoot: root, model: "m" }).id
  layer = 0
  layerDuringRun = 0
  launches = []
})
afterEach(() => closeDb())

const exec: ExecBuffer = async (args) =>
  ({
    code: 0,
    stdout: Buffer.from(args[0] === "container" ? `${layer}` : ""),
    stderr: "",
  }) as BufferResult

/** what the sandbox's writable layer grows to while the specialist runs */
let layerDuringRun = 0

function launcher(mode = "answer"): Launcher {
  return {
    preflight: async () => null,
    launch: (ws, m, _limits, box) => {
      launches.push({ box, cwd: ws.workspace })
      if (layerDuringRun) layer = layerDuringRun
      return {
        command: process.execPath,
        args: [FAKE, ...claudeArgs(m).slice(1)],
        cwd: ws.workspace,
        env: { HFR_FAKE: mode, HFR_FAKE_LOG: fakeLog, HFR_RUN: ws.runDir, PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
      }
    },
  }
}

const deps = (mode = "answer", discard = true) => ({
  log,
  dataDir: data,
  launcher: launcher(mode),
  settings: () => ({ ...DEFAULT_SETTINGS, timeoutMinutes: 1, discardOnCompletion: discard }),
})
const boxes = () => new SpecialistBoxes({ exec, log, dataDir: data, sourceRoot: root, taskId, discard: () => true, everyMs: 60_000 })
const pkg = (o: Record<string, unknown> = {}) => ContextPackageSchema.parse({ brief: "b", objective: "Look at /work/src/a.ts", files: ["src/a.ts"], ...o })

describe("delegating into a sandbox (R4.1, R4.2, R4.8)", () => {
  it("runs in the sandbox's workspace, copying only the package's missing files, and leaves the sandbox up", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 2, memoryMb: 2048, diskMb: 100, pidsLimit: 256 })
    await s.copy(box.id, ["src/a.ts"], [])
    // the orchestrator unpacked something there already: a second delegation must not overwrite it
    writeFileSync(join(box.ws.workspace, "src", "a.ts"), "export const a = 1 // unpacked\n")
    const r = await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg({ files: ["src/a.ts", "src/b.ts"] }), sandbox: { boxes: s, id: box.id } })
    expect(launches).toEqual([{ box: box.name, cwd: box.ws.workspace }])
    expect(readFileSync(join(box.ws.workspace, "src", "a.ts"), "utf8")).toContain("// unpacked")
    expect(readFileSync(join(box.ws.workspace, "src", "b.ts"), "utf8")).toBe("export const b = 2\n")
    expect(r.report).toContain("analysed src/a.ts")
    // discard on completion does not touch a sandbox: it outlives the delegation
    expect(existsSync(box.ws.workspace)).toBe(true)
    expect(s.ids()).toEqual([box.id])
    expect(box.busy).toBe(false)
    await s.disposeAll()
  })

  it("refuses a sandbox that is running a delegation, or that the task does not have", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 100, pidsLimit: 256 })
    const held = s.hold(box.id)
    await expect(delegate(deps(), { taskId, sourceRoot: root, pkg: pkg(), sandbox: { boxes: s, id: box.id } })).rejects.toThrow(DelegationRefused)
    await held.release()
    await expect(delegate(deps(), { taskId, sourceRoot: root, pkg: pkg(), sandbox: { boxes: s, id: "nope" } })).rejects.toThrow(/no sandbox nope/)
    expect(launches).toEqual([])
    await s.disposeAll()
  })

  it("clears the questions and answers an earlier delegation left on the ask channel", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 100, pidsLimit: 256 })
    writeFileSync(join(askDir(box.ws.runDir), "q-1.json"), "{}")
    writeFileSync(join(askDir(box.ws.runDir), "a-1.json"), "{}")
    await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg(), sandbox: { boxes: s, id: box.id } })
    expect(readdirSync(askDir(box.ws.runDir))).toEqual([])
    await s.disposeAll()
  })

  it("tells the specialist in a sandbox that /work is writable but stays as it is in read mode (R4.7)", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 100, pidsLimit: 256 })
    await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg(), sandbox: { boxes: s, id: box.id } })
    const system = readFileSync(join(box.ws.runDir, "system.md"), "utf8")
    expect(system).toContain("Leave the files in /work as they are")
    expect(system).toContain("root")
    await s.disposeAll()
  })

  it("names the sandbox's stop when its disk limit ended the run", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 1, pidsLimit: 256 })
    layerDuringRun = 5 * 1024 * 1024
    await expect(delegate(deps("limit"), { taskId, sourceRoot: root, pkg: pkg(), sandbox: { boxes: s, id: box.id } })).rejects.toThrow(
      /plan.s limit is reached.*\(sandbox .* was stopped: it used \d+ MB of disk, past its 1 MB limit\)/,
    )
    await s.disposeAll()
  })
})

describe("patches from a sandbox (R4.5)", () => {
  it("makes the next patch against what the previous one proposed", async () => {
    const s = boxes()
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 100, pidsLimit: 256 })
    const first = await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg({ mode: "modify" }), sandbox: { boxes: s, id: box.id } })
    expect(first.patch?.files.map((f) => f.path)).toEqual(["src/a.ts"])
    const fixed = "export const a = 1 // fixed\n"
    expect(readManifest(box.ws.snapshot)["src/a.ts"]).toBe(sha256(fixed))
    const second = await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg({ mode: "modify" }), sandbox: { boxes: s, id: box.id } })
    // only the second edit, on top of the first
    expect(second.patch?.diff).toContain("-export const a = 1 // fixed")
    expect(second.patch?.diff).toContain("+export const a = 1 // fixed // fixed")
    await s.disposeAll()
  })
})

describe("the production launcher in a sandbox (R4.1, R4.4)", () => {
  it("runs the CLI with docker exec and stops only the CLI", async () => {
    const calls: string[][] = []
    const l = dockerLauncher(async (args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }))
    const launch = l.launch({ id: "i", workspace: "w", runDir: "r", snapshot: "s", files: [] }, "read", {}, "hfr-sbx-1")
    expect(launch.args).toEqual(execArgs("hfr-sbx-1", claudeArgs("read")))
    await launch.stop!()
    expect(calls).toEqual([stopArgs("hfr-sbx-1")])
  })
})
