import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { closeDb, getDb, openDb } from "../src/main/db"
import type { EventLog } from "../src/main/events/log"
import { INSTALL_CAPS, SPECIALIST_IMAGE } from "../src/main/sandbox/docker"
import { PathRejected } from "../src/main/sandbox/paths"
import {
  COMMAND_DEFAULT_S,
  folderSize,
  recreated,
  sandboxArgs,
  sandboxName,
  SandboxError,
  SpecialistBoxes,
  type BoxLimits,
} from "../src/main/sandbox/specialistbox"
import { dockerExecBuffer, labelled, type BufferResult, type ExecBuffer } from "../src/main/sandbox/taskbox"
import { readManifest } from "../src/main/sandbox/workspace"

/* specs/specialist-sandbox R1–R3: the sandboxes the orchestrator creates, controls and destroys, and their disk watch. */

let base = ""
let root = ""
let data = ""

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-sbx-"))
  root = join(base, "repo")
  data = join(base, "data")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.bin"), Buffer.alloc(1000))
  openDb(join(data, "hfr.db"))
  // the sandboxes are recorded against their task
  getDb().prepare("INSERT INTO tasks (id, request, source_root, model, state, created_at, updated_at) VALUES ('t1', 'r', ?, 'm', 'running', 0, 0)").run(root)
})
afterEach(() => closeDb())

const limits: BoxLimits = { cpus: 4, memoryMb: 8192, diskMb: 1, pidsLimit: 512 }
const after = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag)

interface Fake {
  exec: ExecBuffer
  calls: { args: string[]; timeoutMs?: number }[]
  events: { kind: string; payload: Record<string, unknown> }[]
  /** what `container inspect --size` reports as the writable layer */
  layer: number
  /** the config label `inspect` reports for an existing container; none when unset */
  label?: string
}

function fake(answers: Record<string, Partial<BufferResult>> = {}): Fake {
  const f: Fake = { calls: [], events: [], layer: 0, exec: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) }
  f.exec = async (args, timeoutMs) => {
    f.calls.push({ args, timeoutMs })
    const key = args.join(" ")
    if (key.startsWith("container inspect --size")) return { code: 0, stdout: Buffer.from(`${f.layer}\n`), stderr: "" }
    if (args[0] === "inspect" && !answers.inspect)
      return f.label ? { code: 0, stdout: Buffer.from(f.label), stderr: "" } : { code: 1, stdout: Buffer.alloc(0), stderr: "Error: No such object" }
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k))?.[1]
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", ...hit }
  }
  return f
}

function boxes(f: Fake, everyMs = 60_000) {
  const log = {
    append: (e: { kind: string; payload?: Record<string, unknown> }) => f.events.push({ kind: e.kind, payload: e.payload ?? {} }),
  } as unknown as EventLog
  return new SpecialistBoxes({ exec: f.exec, log, taskDir: data, sourceRoot: root, taskId: "t1", everyMs })
}

describe("a sandbox's docker run arguments (R1.1–R1.3)", () => {
  const ws = { id: "x", workspace: "C:\\d\\workspace\\x", runDir: "C:\\d\\runs\\x", snapshot: "C:\\d\\snapshots\\x", out: "C:\\d\\outputs\\x", files: [] }
  const args = sandboxArgs(sandboxName("x"), ws, limits, "C:\\d\\outputs\\x")

  it("starts a long-lived container from the specialist image with the orchestrator's limits", () => {
    expect(args.slice(0, 2)).toEqual(["run", "-d"])
    // kept when stopped, so what was installed outlives the task's end (specs/task-persistence R3.4)
    expect(args).not.toContain("--rm")
    expect(after(args, "--name")).toEqual(["hfr-sbx-x"])
    expect(after(args, "--memory")).toEqual(["8192m"])
    expect(after(args, "--cpus")).toEqual(["4"])
    expect(after(args, "--pids-limit")).toEqual(["512"])
    expect(args.slice(-2)).toEqual([SPECIALIST_IMAGE, "infinity"])
    expect(after(args, "--entrypoint")).toEqual(["sleep"])
  })

  it("runs as root:root with only the install capabilities and a writable root, on Docker's default network", () => {
    expect(after(args, "--user")).toEqual(["0:0"])
    expect(after(args, "--cap-drop")).toEqual(["ALL"])
    expect(after(args, "--cap-add")).toEqual(INSTALL_CAPS)
    expect(after(args, "--security-opt")).toEqual(["no-new-privileges"])
    expect(args).not.toContain("--read-only")
    expect(args).not.toContain("--privileged")
    expect(args).not.toContain("--network")
  })

  it("binds only its workspace, run directory, ask channel and output folder, besides the login volume (specs/task-persistence R3.3)", () => {
    expect(after(args, "--mount")).toEqual([
      "type=volume,source=hfr-claude-config,target=/home/agent/.claude-config",
      "type=bind,source=C:\\d\\workspace\\x,target=/work",
      "type=bind,source=C:\\d\\runs\\x,target=/run/hfr,readonly",
      `type=bind,source=${join("C:\\d\\runs\\x", "ask")},target=/run/hfr-ask`,
      "type=bind,source=C:\\d\\outputs\\x,target=/root/out",
    ])
    expect(args).not.toContain("-v")
    expect(args.join(" ")).not.toMatch(/docker\.sock|--tmpfs/)
  })
})

describe("creating, controlling and destroying sandboxes (R1.4, R1.5, R2)", () => {
  it("creates a sandbox, records it, and keeps nothing when Docker refuses", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create(limits)
    expect(f.calls[0].args).toEqual(labelled(sandboxArgs(box.name, box.ws, limits, box.outDir)))
    expect(box.outDir).toBe(join(data, "outputs", box.id))
    expect(existsSync(box.outDir)).toBe(true)
    expect(existsSync(box.ws.workspace)).toBe(true)
    expect(f.events.map((e) => e.kind)).toEqual(["sandbox.created"])
    await s.removeAll()

    const before = readdirSync(join(data, "workspace"))
    const refused = fake({ "run -d": { code: 125, stderr: "docker: Error response from daemon: range of CPUs is from 0.01 to 16.00" } })
    const r = boxes(refused)
    await expect(r.create({ ...limits, cpus: 64 })).rejects.toThrow(/Docker did not start the sandbox: .*range of CPUs/)
    expect(r.ids()).toEqual([])
    // nothing of the refused sandbox: no folder, no record
    expect(readdirSync(join(data, "workspace"))).toEqual(before)
    expect(boxes(fake()).ids()).toEqual([])
  })

  it("copies source files and scratch files into /work and refuses a path outside the source", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create({ ...limits, diskMb: 10 })
    const files = await s.copy(box.id, ["src/a.bin"], [{ path: "probe.py", content: Buffer.from("print(1)") }])
    expect(files.map((x) => x.path)).toEqual(["src/a.bin", ".orchestrator/probe.py"])
    expect(readFileSync(join(box.ws.workspace, "src", "a.bin")).length).toBe(1000)
    expect(Object.keys(readManifest(box.ws.snapshot))).toEqual(["src/a.bin"])
    await expect(s.copy(box.id, ["../outside"], [])).rejects.toThrow(PathRejected)
    expect(f.events.filter((e) => e.kind === "sandbox.copy")).toHaveLength(1)
    await s.removeAll()
  })

  it("refuses a copy that would pass the disk limit, copying nothing", async () => {
    const f = fake()
    f.layer = 1024 * 1024 - 500
    const s = boxes(f)
    const box = await s.create(limits)
    await expect(s.copy(box.id, ["src/a.bin"], [])).rejects.toThrow(/1 MB disk limit/)
    expect(existsSync(join(box.ws.workspace, "src", "a.bin"))).toBe(false)
    await s.removeAll()
  })

  it("runs a command as root in /work under its time limit, capped, and records it", async () => {
    const f = fake({ "exec -w /work": { code: 3, stdout: Buffer.from("installed\n"), stderr: "warn" } })
    const s = boxes(f)
    const box = await s.create(limits)
    const r = await s.run(box.id, "apt-get install -y binutils")
    expect(r).toEqual({ output: "installed\nwarn", exitCode: 3, truncated: false })
    const call = f.calls.find((c) => c.args[0] === "exec")!
    expect(call.args).toEqual(["exec", "-w", "/work", box.name, "timeout", "-s", "KILL", String(COMMAND_DEFAULT_S), "sh", "-c", "apt-get install -y binutils"])
    expect(call.timeoutMs).toBeGreaterThan(COMMAND_DEFAULT_S * 1000)
    await s.run(box.id, "true", 30)
    expect(f.calls.filter((c) => c.args[0] === "exec")[1].args[7]).toBe("30")
    expect(f.events.find((e) => e.kind === "sandbox.exec")?.payload).toMatchObject({ sandbox: box.id, command: "apt-get install -y binutils", exitCode: 3 })
    await s.removeAll()
  })

  it("refuses a sandbox this task does not have", async () => {
    const s = boxes(fake())
    expect(() => s.usable("nope")).toThrow(SandboxError)
    await expect(s.run("nope", "ls")).rejects.toThrow(/no sandbox nope in this task/)
    await expect(s.destroy("nope")).rejects.toThrow(SandboxError)
  })

  it("destroys a sandbox: container and record removed, its folders kept for the task (specs/task-persistence R4.3)", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create(limits)
    await s.destroy(box.id)
    expect(f.calls.at(-1)!.args).toEqual(["rm", "-f", box.name])
    expect(existsSync(box.ws.workspace)).toBe(true)
    expect(f.events.at(-1)!.kind).toBe("sandbox.destroyed")
    expect(() => s.usable(box.id)).toThrow(SandboxError)
    expect(boxes(fake()).ids()).toEqual([])
  })

  it("stops, and keeps, every sandbox of the task when it ends (specs/task-persistence R3.4)", async () => {
    const f = fake()
    const s = boxes(f)
    const a = await s.create(limits)
    const b = await s.create(limits)
    await s.stopAll()
    expect(f.calls.at(-1)!.args).toEqual(["stop", "-t", "2", a.name, b.name])
    expect(f.calls.some((c) => c.args[0] === "rm")).toBe(false)
    expect(existsSync(a.ws.workspace)).toBe(true)
  })

  it("stops, and keeps, the sandboxes a previous run of the app left running", async () => {
    const f = fake({ "ps -q": { stdout: Buffer.from("aaa\nbbb\n") } })
    expect(await SpecialistBoxes.sweep(f.exec)).toBe(2)
    expect(f.calls[0].args).toEqual(["ps", "-q", "--filter", "name=^hfr-sbx-"])
    expect(f.calls[1].args).toEqual(["stop", "-t", "2", "aaa", "bbb"])
  })

  it("holds a sandbox for one delegation at a time", async () => {
    const s = boxes(fake())
    const box = await s.create(limits)
    const held = await s.hold(box.id)
    await expect(s.hold(box.id)).rejects.toThrow(/already running a delegation/)
    await held.release()
    await (await s.hold(box.id)).release()
    await s.removeAll()
  })
})

describe("the disk limit (R3)", () => {
  it("measures the writable layer plus the workspace", async () => {
    const f = fake()
    f.layer = 4096
    const s = boxes(f)
    const box = await s.create({ ...limits, diskMb: 10 })
    await s.copy(box.id, ["src/a.bin"], [])
    expect(await s.usage(box)).toBe(4096 + 1000)
    expect(folderSize(box.ws.workspace)).toBe(1000)
    await s.removeAll()
  })

  it("stops a sandbox past its limit after a command, records it, and refuses it afterwards", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create(limits)
    f.layer = 2 * 1024 * 1024
    const r = await s.run(box.id, "dd if=/dev/zero of=/big bs=1M count=2")
    expect(r.output).toMatch(/was stopped: it used 2 MB of disk, past its 1 MB limit/)
    expect(f.calls.some((c) => c.args.join(" ") === `kill ${box.name}`)).toBe(true)
    expect(f.events.find((e) => e.kind === "sandbox.stopped")?.payload).toMatchObject({ sandbox: box.id, usedMb: 2, diskMb: 1 })
    await expect(s.run(box.id, "ls")).rejects.toThrow(/was stopped: it used 2 MB/)
    await expect(s.hold(box.id)).rejects.toThrow(/was stopped/)
    await s.destroy(box.id)
  })

  it("watches on an interval while the sandbox runs", async () => {
    const f = fake()
    const s = boxes(f, 20)
    const box = await s.create(limits)
    f.layer = 5 * 1024 * 1024
    await new Promise((r) => setTimeout(r, 120))
    expect(box.stopped).toMatch(/past its 1 MB limit/)
    expect(f.events.filter((e) => e.kind === "sandbox.stopped")).toHaveLength(1)
    await s.removeAll()
  })

  it("does not stop a sandbox within its limit", async () => {
    const f = fake()
    f.layer = 1000
    const s = boxes(f)
    const box = await s.create(limits)
    await s.run(box.id, "true")
    expect(box.stopped).toBeNull()
    await s.removeAll()
  })
})

/* Against the real Docker and the built image: HFR_DOCKER=1 npx vitest run tests/specialistbox.test.ts */
describe.skipIf(!process.env.HFR_DOCKER)("SpecialistBoxes on Docker", () => {
  it("creates a root sandbox, copies in, installs and runs, and stops it past its disk", async () => {
    const f = fake()
    const log = { append: (e: { kind: string }) => f.events.push({ kind: e.kind, payload: {} }) } as unknown as EventLog
    const s = new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: data, sourceRoot: root, taskId: "t1", everyMs: 60_000 })
    const box = await s.create({ cpus: 1, memoryMb: 512, diskMb: 64, pidsLimit: 256 })
    try {
      await s.copy(box.id, ["src/a.bin"], [])
      expect((await s.run(box.id, "id -u; id -g")).output.trim()).toBe("0\n0")
      expect((await s.run(box.id, "wc -c < /work/src/a.bin")).output.trim()).toBe("1000")
      expect((await s.run(box.id, "touch /usr/local/bin/x && echo writable")).output.trim()).toBe("writable")
      expect((await s.run(box.id, "getent hosts example.com || echo no-dns")).output).not.toContain("no-dns")
      const big = await s.run(box.id, "dd if=/dev/zero of=/root/big bs=1M count=100 2>/dev/null; echo done")
      expect(big.output).toMatch(/was stopped: .*past its 64 MB limit/)
      expect(f.events.map((e) => e.kind)).toContain("sandbox.stopped")
    } finally {
      await s.removeAll()
    }
    expect((await dockerExecBuffer(["ps", "-aq", "--filter", `name=^${box.name}$`])).stdout.toString().trim()).toBe("")
  }, 120_000)

  it("keeps what was installed and extracted across the task's end and reopening (specs/task-persistence R3.3–R3.6)", async () => {
    const log = { append: () => undefined } as unknown as EventLog
    const first = new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: data, sourceRoot: root, taskId: "t1" })
    const box = await first.create({})
    try {
      await first.run(box.id, "touch /usr/local/bin/installed && echo extracted > /root/out/notes.txt")
      await first.stopAll()
      const reopened = new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: data, sourceRoot: root, taskId: "t1" })
      expect((await reopened.run(box.id, "ls /usr/local/bin/installed; cat /root/out/notes.txt")).output).toBe("/usr/local/bin/installed\nextracted\n")
      // Docker lost it: created again, the output folder still there
      await reopened.stopAll()
      await dockerExecBuffer(["rm", "-f", box.name])
      const again = new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: data, sourceRoot: root, taskId: "t1" })
      expect((await again.run(box.id, "cat /root/out/notes.txt")).output).toMatch(/created again.*extracted/s)
      await again.removeAll()
    } finally {
      await dockerExecBuffer(["rm", "-f", box.name])
    }
  }, 120_000)

  it("leaves nothing when Docker refuses the limits", async () => {
    const s = new SpecialistBoxes({
      exec: dockerExecBuffer,
      log: { append: () => undefined } as unknown as EventLog,
      taskDir: data,
      sourceRoot: root,
      taskId: "t1",
    })
    await expect(s.create({ cpus: 4096, memoryMb: 512, diskMb: 64, pidsLimit: 256 })).rejects.toThrow(/Docker did not start the sandbox/)
  }, 60_000)
})

describe("a sandbox with no limits (R1.5)", () => {
  it("passes no limit to Docker, copies any size and is never stopped for its disk", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create({})
    const run = f.calls[0].args
    for (const flag of ["--memory", "--cpus", "--pids-limit", "--storage-opt"]) expect(run).not.toContain(flag)
    expect(box.timer).toBeNull()
    f.layer = 500 * 1024 * 1024 * 1024
    await s.copy(box.id, ["src/a.bin"], [])
    await s.run(box.id, "true")
    expect(box.stopped).toBeNull()
    // no disk limit, nothing to measure
    expect(f.calls.some((c) => c.args[0] === "container")).toBe(false)
    expect(f.events[0].kind).toBe("sandbox.created")
    await s.removeAll()
  })
})

describe("review fixes: a measurement that cannot be told, and races with the task's end", () => {
  it("stops counting past the entry cap and reports the size unknown, so the sandbox is not stopped on a guess", async () => {
    mkdirSync(join(base, "many"))
    for (let i = 0; i < 5; i++) writeFileSync(join(base, "many", `f${i}`), "x")
    expect(folderSize(join(base, "many"), { entries: 3 })).toBeNull()
    expect(folderSize(join(base, "many"))).toBe(5)
    expect(folderSize(join(base, "missing"))).toBe(0)
  })

  it("skips a sandbox whose writable layer cannot be read, and catches a failed interval check", async () => {
    const f = fake()
    // inspect fails, as for a container Docker no longer knows
    const inner = f.exec
    f.exec = async (args, t) => (args[0] === "container" ? { code: 1, stdout: Buffer.alloc(0), stderr: "gone" } : inner(args, t))
    const s = boxes(f)
    const box = await s.create(limits)
    await s.run(box.id, "true")
    expect(box.stopped).toBeNull()
    await s.removeAll()
  })

  it("refuses to destroy a sandbox a delegation runs in, but deleting the task removes it", async () => {
    const f = fake()
    const s = boxes(f)
    const box = await s.create(limits)
    await s.hold(box.id)
    await expect(s.destroy(box.id)).rejects.toThrow(/running a delegation/)
    await s.removeAll()
    expect(s.ids()).toEqual([])
  })

  it("removes a sandbox that finished starting after the task ended", async () => {
    let started: () => void = () => undefined
    const f = fake()
    const inner = f.exec
    f.exec = async (args, t) => {
      if (args[0] === "run") await new Promise<void>((r) => (started = r))
      return inner(args, t)
    }
    const s = boxes(f)
    const pending = s.create(limits)
    await new Promise((r) => setTimeout(r, 10))
    await s.stopAll()
    started()
    await expect(pending).rejects.toThrow(/task ended while the sandbox was starting/)
    expect(f.calls.at(-1)!.args.slice(0, 2)).toEqual(["rm", "-f"])
    expect(s.ids()).toEqual([])
  })

  it("starts the sandbox with an init that reaps orphaned processes", () => {
    const ws = { id: "x", workspace: "C:/d/w", runDir: "C:/d/r", snapshot: "C:/d/s", out: "C:/d/o", files: [] }
    expect(sandboxArgs("hfr-sbx-x", ws, {}, "C:/d/o")).toContain("--init")
  })
})

describe("a sandbox across the task's reopening (specs/task-persistence R3.5, R3.6)", () => {
  it("is recorded, found again by a reopened task under the same id, and started again on first use", async () => {
    const f = fake()
    const first = boxes(f)
    const box = await first.create(limits)
    await first.copy(box.id, ["src/a.bin"], [])
    await first.stopAll()
    // the task reopens, in this run of the app or a later one
    const again = fake({ "exec -w /work": { stdout: Buffer.from("ok\n") } })
    again.label = labelled(sandboxArgs(box.name, box.ws, limits, box.outDir))[3]
    const reopened = boxes(again)
    expect(reopened.ids()).toEqual([box.id])
    expect(reopened.usable(box.id).ws.files.map((x) => x.path)).toEqual(["src/a.bin"])
    expect(again.calls).toEqual([])
    const r = await reopened.run(box.id, "ls")
    expect(again.calls[0].args[0]).toBe("inspect")
    expect(again.calls[1].args).toEqual(["start", box.name])
    expect(r.output).toBe("ok\n")
    expect(again.events.map((e) => e.kind)).toContain("sandbox.reopened")
    // started once, not on every call
    await reopened.run(box.id, "ls")
    expect(again.calls.filter((c) => c.args[0] === "start")).toHaveLength(1)
    await reopened.removeAll()
  })

  it("is created again over its folders when Docker no longer has it, and says what was lost", async () => {
    const first = boxes(fake())
    const box = await first.create({})
    await first.stopAll()
    const gone = fake({ "exec -w /work": { stdout: Buffer.from("ok\n") } })
    const reopened = boxes(gone)
    const r = await reopened.run(box.id, "ls")
    const run = gone.calls.find((c) => c.args[0] === "run")!.args
    expect(run).toEqual(labelled(sandboxArgs(box.name, box.ws, {}, box.outDir)))
    expect(r.output).toBe(`${recreated(box.id)} ok\n`)
    expect(recreated(box.id)).toMatch(/\/work and \/root\/out were kept, anything installed is gone/)
    await reopened.removeAll()
  })

  it("is removed with its record when the task is deleted (specs/task-persistence R4.1)", async () => {
    const f = fake()
    const s = boxes(f)
    const a = await s.create(limits)
    await s.stopAll()
    const reopened = boxes(f)
    await reopened.removeAll()
    expect(f.calls.at(-1)!.args).toEqual(["rm", "-f", a.name])
    expect(boxes(fake()).ids()).toEqual([])
  })
})

describe("deleting a task's sandboxes (specs/task-persistence R4.1)", () => {
  it("removes every recorded container, even one whose folders are gone, and keeps the records when Docker fails", async () => {
    const s = boxes(fake())
    const box = await s.create({})
    await s.stopAll()
    rmSync(box.ws.workspace, { recursive: true, force: true })
    const f = fake()
    const reopened = boxes(f)
    expect(reopened.ids()).toEqual([])
    await reopened.removeAll()
    expect(f.calls.at(-1)!.args).toEqual(["rm", "-f", box.name])

    const kept = await boxes(fake()).create({})
    const failing = boxes(fake({ "rm -f": { code: 1, stderr: "Error response from daemon: device or resource busy" } }))
    await expect(failing.removeAll()).rejects.toThrow(/could not be removed: .*busy/)
    expect(boxes(fake()).ids()).toEqual([kept.id])
  })
})
