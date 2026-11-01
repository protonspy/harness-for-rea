import { randomUUID } from "node:crypto"
import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { EventLog } from "../events/log"
import { identity, limitArgs, loginVolume, mountSource, SPECIALIST_IMAGE } from "./docker"
import { OUTPUT_CAP, type ExecBuffer } from "./taskbox"
import { addFiles, askDir, createWorkspace, discardWorkspace, type CopiedFile, type PreparedFile, type Workspace } from "./workspace"

/*
  The sandboxes the orchestrator creates for the specialist (adr:0015-let-the-orchestrator-run-the-specialists-sandbox,
  specs/specialist-sandbox): one long-lived root container per sandbox, with the limits the orchestrator chose,
  its workspace at /work, files copied in from the source folder or the orchestrator's scratch, commands run in it
  as root, delegations run in it one at a time, and its disk watched against its limit. One `SpecialistBoxes` per
  task; every sandbox goes with the task.
*/

const MB = 1024 * 1024
/** How often a running sandbox's disk is measured besides after each call (specs/specialist-sandbox R3.2). */
export const DISK_EVERY_MS = 15_000
/** A command's time limit when the orchestrator gives none, and the most it may give (R2.4). */
export const COMMAND_DEFAULT_S = 600
export const COMMAND_MAX_S = 86_400

/** What the orchestrator chose; each one left out is no limit, and no disk watch without `diskMb` (R1.5). */
export interface BoxLimits {
  cpus?: number
  memoryMb?: number
  diskMb?: number
  pidsLimit?: number
}

export interface Box {
  id: string
  name: string
  ws: Workspace
  limits: BoxLimits
  /** a delegation runs in it */
  busy: boolean
  /** why it was stopped, once it was */
  stopped: string | null
  timer: ReturnType<typeof setInterval> | null
}

/** A call the orchestrator made that the sandbox service refuses; its message goes back to the orchestrator. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxError"
  }
}

export function sandboxName(id: string): string {
  return `hfr-sbx-${id}`
}

/**
  `docker run` for a sandbox (R1.1–R1.3): root with the install capabilities and a writable root, Docker's default
  network, the login volume, and only its workspace, run directory and ask channel bound; never privileged, never
  the Docker socket. `/tmp` is no tmpfs, so what is written there counts toward the disk.
*/
export function sandboxArgs(name: string, ws: Workspace, limits: BoxLimits): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--hostname",
    "sandbox",
    ...identity(true),
    ...limitArgs(limits),
    ...loginVolume(),
    "--mount",
    `type=bind,source=${mountSource(ws.workspace)},target=/work`,
    "--mount",
    `type=bind,source=${mountSource(ws.runDir)},target=/run/hfr,readonly`,
    "--mount",
    `type=bind,source=${mountSource(askDir(ws.runDir))},target=/run/hfr-ask`,
    "-w",
    "/work",
    "--entrypoint",
    "sleep",
    SPECIALIST_IMAGE,
    "infinity",
  ]
}

/** Bytes of regular files under a folder, links not followed. */
export function folderSize(dir: string): number {
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const abs = join(dir, name)
    const st = lstatSync(abs)
    if (st.isDirectory()) total += folderSize(abs)
    else if (st.isFile()) total += st.size
  }
  return total
}

/** The limits as the orchestrator chose them, for the event log. */
export function describeLimits(l: BoxLimits): string {
  const part = (v: number | undefined, unit: string) => (v === undefined ? `no ${unit} limit` : `${v} ${unit}`)
  return [part(l.cpus, "CPU"), part(l.memoryMb, "MB memory"), part(l.diskMb, "MB disk"), part(l.pidsLimit, "processes")].join(", ")
}

const lastLine = (s: string) => s.trim().split("\n").pop()?.trim() ?? ""

export interface BoxesDeps {
  exec: ExecBuffer
  log: EventLog
  dataDir: string
  sourceRoot: string
  taskId: string
  /** whether a destroyed sandbox's workspace, run directory and snapshot are deleted */
  discard(): boolean
  everyMs?: number
}

export class SpecialistBoxes {
  private readonly boxes = new Map<string, Box>()
  private readonly d: BoxesDeps

  constructor(deps: BoxesDeps) {
    this.d = deps
  }

  private event(kind: string, summary: string, payload: Record<string, unknown>) {
    this.d.log.append({ taskId: this.d.taskId, agent: "sandbox", kind, summary, payload })
  }

  /** Start a sandbox with the orchestrator's limits; Docker's refusal comes back as the error, leaving nothing (R1.1, R1.4). */
  async create(limits: BoxLimits): Promise<Box> {
    const id = randomUUID()
    const name = sandboxName(id)
    const ws = createWorkspace(this.d.dataDir, id)
    let args: string[]
    try {
      args = sandboxArgs(name, ws, limits)
    } catch (e) {
      discardWorkspace(this.d.dataDir, id)
      throw new SandboxError((e as Error).message)
    }
    const r = await this.d.exec(args)
    if (r.code !== 0) {
      await this.d.exec(["rm", "-f", name])
      discardWorkspace(this.d.dataDir, id)
      throw new SandboxError(`Docker did not start the sandbox: ${lastLine(r.stderr) || `exit ${r.code}`}`)
    }
    const box: Box = { id, name, ws, limits, busy: false, stopped: null, timer: null }
    // Only a disk limit is watched; without one the sandbox takes what Docker has (R1.5).
    if (limits.diskMb !== undefined) {
      box.timer = setInterval(() => void this.checkDisk(box), this.d.everyMs ?? DISK_EVERY_MS)
      box.timer.unref?.()
    }
    this.boxes.set(id, box)
    this.event("sandbox.created", `Created sandbox ${id}: ${describeLimits(limits)}`, { sandbox: id, ...limits })
    return box
  }

  /** The sandbox by id, refusing one this task does not have or that was stopped (R2.8). */
  usable(id: string): Box {
    const box = this.boxes.get(id)
    if (!box) throw new SandboxError(`There is no sandbox ${id} in this task; create one with sandbox_create.`)
    if (box.stopped) throw new SandboxError(`Sandbox ${id} was stopped: ${box.stopped}. Destroy it and create another.`)
    return box
  }

  /** Copy files from the source folder and the scratch into /work, all or none, within the disk left (R2.1–R2.3). */
  async copy(id: string, requested: string[], prepared: PreparedFile[]): Promise<CopiedFile[]> {
    const box = this.usable(id)
    const disk = box.limits.diskMb
    const left = disk === undefined ? Infinity : Math.max(0, disk * MB - (await this.usage(box)))
    const files = addFiles(box.ws, this.d.sourceRoot, requested, prepared, left, `${disk} MB disk limit of sandbox ${id}`)
    this.event("sandbox.copy", `Copied ${files.length} file(s) into sandbox ${id}`, {
      sandbox: id,
      files: files.map((f) => ({ path: f.path, op: "copy" })),
      sha256: Object.fromEntries(files.map((f) => [f.path, f.sha256])),
    })
    await this.checkDisk(box)
    return files
  }

  /** Run a command as root in /work, stopped at its time limit, its output capped (R2.4). */
  async run(id: string, command: string, timeoutS = COMMAND_DEFAULT_S): Promise<{ output: string; exitCode: number; truncated: boolean }> {
    const box = this.usable(id)
    const limit = Math.min(Math.max(1, Math.floor(timeoutS)), COMMAND_MAX_S)
    const r = await this.d.exec(["exec", "-w", "/work", box.name, "timeout", "-s", "KILL", String(limit), "sh", "-c", command], (limit + 10) * 1000)
    let output = r.stdout.toString("utf8") + r.stderr
    const truncated = r.overflow === true || output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    this.event("sandbox.exec", `Ran in sandbox ${id}: ${command.slice(0, 120)}`, { sandbox: id, command, exitCode: r.code, output: output.slice(0, 4000) })
    await this.checkDisk(box)
    if (box.stopped) output += `\n[Sandbox ${id} was stopped: ${box.stopped}]`
    return { output, exitCode: r.code, truncated }
  }

  /** Bytes the sandbox uses: its container's writable layer plus its workspace (R3.1). */
  async usage(box: Box): Promise<number> {
    const r = await this.d.exec(["container", "inspect", "--size", "--format", "{{.SizeRw}}", box.name])
    const layer = r.code === 0 ? Number(r.stdout.toString("utf8").trim()) || 0 : 0
    return layer + folderSize(box.ws.workspace)
  }

  /** Measure the disk and stop the sandbox past its limit (R3.2, R3.3); a stopped sandbox is not measured again. */
  async checkDisk(box: Box): Promise<void> {
    const disk = box.limits.diskMb
    if (disk === undefined || box.stopped || !this.boxes.has(box.id)) return
    const used = await this.usage(box)
    if (used <= disk * MB || box.stopped) return
    const usedMb = Math.ceil(used / MB)
    box.stopped = `it used ${usedMb} MB of disk, past its ${disk} MB limit`
    if (box.timer) clearInterval(box.timer)
    await this.d.exec(["kill", box.name])
    this.event("sandbox.stopped", `Stopped sandbox ${box.id}: ${box.stopped}`, { sandbox: box.id, usedMb, diskMb: box.limits.diskMb })
  }

  /** Hold the sandbox for one delegation; refused while another runs in it (specs/specialist-sandbox R4.2). */
  hold(id: string): { box: Box; release: () => Promise<void> } {
    const box = this.usable(id)
    if (box.busy) throw new SandboxError(`Sandbox ${id} is already running a delegation; wait for it to end.`)
    box.busy = true
    let released = false
    return {
      box,
      // Once: the delegation releases on failure to read the sandbox's state, and again on its way out.
      release: async () => {
        if (released) return
        released = true
        box.busy = false
        await this.checkDisk(box)
      },
    }
  }

  /** Remove the sandbox's container and, when discarding, its workspace, run directory and snapshot (R2.5). */
  async destroy(id: string): Promise<void> {
    const box = this.boxes.get(id)
    if (!box) throw new SandboxError(`There is no sandbox ${id} in this task.`)
    this.boxes.delete(id)
    if (box.timer) clearInterval(box.timer)
    await this.d.exec(["rm", "-f", box.name])
    if (this.d.discard()) discardWorkspace(this.d.dataDir, id)
    this.event("sandbox.destroyed", `Destroyed sandbox ${id}`, { sandbox: id })
  }

  /** Every sandbox of the task, when it ends (R2.6). */
  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.boxes.keys()].map((id) => this.destroy(id)))
  }

  ids(): string[] {
    return [...this.boxes.keys()]
  }

  /** Remove every sandbox a previous run of the app left behind (R2.7). */
  static async sweep(exec: ExecBuffer): Promise<number> {
    const r = await exec(["ps", "-aq", "--filter", "name=^hfr-sbx-"])
    const ids = r.code === 0 ? r.stdout.toString("utf8").split(/\s+/).filter(Boolean) : []
    if (ids.length) await exec(["rm", "-f", ...ids])
    return ids.length
  }
}
