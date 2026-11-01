import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { getDb } from "../db"
import type { EventLog } from "../events/log"
import { identity, limitArgs, loginVolume, mountSource, SPECIALIST_IMAGE } from "./docker"
import { bringUp, labelled, OUTPUT_CAP, type ExecBuffer } from "./taskbox"
import {
  addFiles,
  askDir,
  createWorkspace,
  discardWorkspace,
  readManifest,
  workspaceDirs,
  type CopiedFile,
  type PreparedFile,
  type Workspace,
} from "./workspace"

/*
  The sandboxes the orchestrator creates for the specialist (adr:0016-let-the-orchestrator-run-the-specialists-sandbox,
  specs/specialist-sandbox): one long-lived root container per sandbox, with the limits the orchestrator chose,
  its workspace at /work, files copied in from the source folder or the orchestrator's scratch, commands run in it
  as root, delegations run in it one at a time, and its disk watched against its limit. One `SpecialistBoxes` per
  task. A sandbox is recorded in the database and its folders live in the task's own, so it is stopped at the
  task's end, brought up again when the task reopens, and created again over the same folders when Docker no
  longer has it; only deleting the task removes it
  (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted, specs/task-persistence R3).
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
  /** the container runs in this process; false for one recorded by an earlier run of the task */
  up: boolean
  /** where the specialist keeps what it extracts and builds, bound at /root/out */
  outDir: string
  /** the task that used it last, which a watch that stops it reports against */
  lastTask?: string
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
  network, the login volume, and only its workspace, run directory, ask channel and output folder bound; never
  privileged, never the Docker socket. `/tmp` is no tmpfs, so what is written there counts toward the disk. Kept
  when stopped (specs/task-persistence R3.4).
*/
export function sandboxArgs(name: string, ws: Workspace, limits: BoxLimits, outDir: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    name,
    "--hostname",
    "sandbox",
    // a PID 1 that reaps what `docker exec` and `timeout` leave behind
    "--init",
    ...identity(true),
    ...limitArgs(limits),
    ...loginVolume(),
    "--mount",
    `type=bind,source=${mountSource(ws.workspace)},target=/work`,
    "--mount",
    `type=bind,source=${mountSource(ws.runDir)},target=/run/hfr,readonly`,
    "--mount",
    `type=bind,source=${mountSource(askDir(ws.runDir))},target=/run/hfr-ask`,
    "--mount",
    `type=bind,source=${mountSource(outDir)},target=/root/out`,
    "-w",
    "/work",
    "--entrypoint",
    "sleep",
    SPECIALIST_IMAGE,
    "infinity",
  ]
}

/** Most entries one measurement of a workspace visits; past it the size is unknown. */
export const FOLDER_ENTRY_CAP = 200_000

/**
  Bytes of regular files under a folder, links not followed, or null when it cannot be told: the sandbox changes
  the folder while it is walked, so an entry gone between listing and reading is skipped, and a tree past the
  entry cap is not walked to its end on the app's main thread.
*/
export function folderSize(dir: string, budget = { entries: FOLDER_ENTRY_CAP }): number | null {
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (--budget.entries < 0) return null
    let st
    try {
      st = lstatSync(join(dir, name))
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const sub = folderSize(join(dir, name), budget)
      if (sub === null) return null
      total += sub
    } else if (st.isFile()) total += st.size
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
  /** the project's folder, where each sandbox's folders live (specs/projects R2.3) */
  dir: string
  sourceRoot: string
  /** the project whose tasks share these sandboxes */
  projectId: string
  everyMs?: number
  /** the task a call made without one is recorded against; none in the app, where every call names its task */
  actor?: string
  /** an earlier instance of the project's sandboxes still stopping: no Docker call is made before it settles */
  after?: Promise<void>
}

/** A project's sandboxes as one of its tasks uses them: every call is recorded against that task. */
export interface TaskSandboxes {
  create(limits: BoxLimits): Promise<Box>
  usable(id: string): Box
  copy(id: string, requested: string[], prepared: PreparedFile[]): Promise<CopiedFile[] & { notice?: string }>
  run(id: string, command: string, timeoutS?: number): Promise<{ output: string; exitCode: number; truncated: boolean }>
  hold(id: string): Promise<{ box: Box; release: () => Promise<void> }>
  destroy(id: string): Promise<void>
  ids(): string[]
}

/** A sandbox created again over its folders after Docker lost it: what the orchestrator is told. */
export const recreated = (id: string) => `[Sandbox ${id} was created again: /work and /root/out were kept, anything installed is gone.]`

export class SpecialistBoxes {
  private readonly boxes = new Map<string, Box>()
  private readonly d: BoxesDeps
  /** the task ended: a sandbox still starting is stopped rather than kept running */
  private ended = false

  /** The project's sandboxes, those an earlier run of any of its tasks recorded included (R3.6, specs/projects R2.3). */
  constructor(deps: BoxesDeps) {
    this.d = deps
    for (const r of getDb()
      .prepare(
        "SELECT s.id, s.created_by, s.limits, t.id AS task FROM sandboxes s LEFT JOIN tasks t ON t.id = s.created_by WHERE s.project_id = ? ORDER BY s.created_at",
      )
      .all(deps.projectId) as Record<string, unknown>[]) {
      const id = String(r.id)
      // A sandbox from before projects lives under the folder of the task that created it (specs/projects R3.3).
      const dirs = [workspaceDirs(deps.dir, id), workspaceDirs(join(deps.dir, "tasks", String(r.created_by)), id)].find((d) => existsSync(d.workspace))
      if (!dirs) continue
      const ws: Workspace = { id, ...dirs, files: [] }
      // A snapshot that cannot be read leaves the sandbox reachable, its files unknown until copied again.
      let manifest: Record<string, string> = {}
      try {
        manifest = readManifest(ws.snapshot)
      } catch {
        manifest = {}
      }
      for (const [path, sha256] of Object.entries(manifest)) ws.files.push({ path, sha256, size: 0 })
      const box = this.box(id, ws, JSON.parse(String(r.limits)) as BoxLimits, false)
      // What happens to it before a task uses it again, a disk stop included, is recorded against the task that made it.
      if (r.task) box.lastTask = String(r.task)
      this.boxes.set(id, box)
    }
  }

  /** Docker, once an earlier instance of these sandboxes finished stopping. */
  private readonly exec: ExecBuffer = async (args, timeoutMs, input) => {
    await this.d.after
    return this.d.exec(args, timeoutMs, input)
  }

  private box(id: string, ws: Workspace, limits: BoxLimits, up: boolean): Box {
    return { id, name: sandboxName(id), ws, limits, busy: false, stopped: null, timer: null, up, outDir: ws.out }
  }

  /** What happened to a sandbox, recorded against the task that did it, or the last one that used it. */
  private event(kind: string, summary: string, payload: Record<string, unknown>, taskId?: string, box?: Box) {
    const who = taskId ?? box?.lastTask ?? this.d.actor
    if (box && taskId) box.lastTask = taskId
    if (who) this.d.log.append({ taskId: who, agent: "sandbox", kind, summary, payload })
  }

  /** The sandboxes as one task uses them, so each call is recorded against it. */
  forTask(taskId: string): TaskSandboxes {
    return {
      create: (limits) => this.create(limits, taskId),
      usable: (id) => this.usable(id),
      copy: (id, requested, prepared) => this.copy(id, requested, prepared, taskId),
      run: (id, command, timeoutS) => this.run(id, command, timeoutS, taskId),
      hold: (id) => this.hold(id),
      destroy: (id) => this.destroy(id, taskId),
      ids: () => this.ids(),
    }
  }

  /** Only a disk limit is watched; without one the sandbox takes what Docker has (R1.5). */
  private watch(box: Box) {
    if (box.limits.diskMb === undefined || box.timer) return
    box.timer = setInterval(() => void this.checkDisk(box).catch(() => undefined), this.d.everyMs ?? DISK_EVERY_MS)
    box.timer.unref?.()
  }

  /** Start a sandbox with the orchestrator's limits; Docker's refusal comes back as the error, leaving nothing (R1.1, R1.4). */
  async create(limits: BoxLimits, taskId?: string): Promise<Box> {
    const id = randomUUID()
    const ws = createWorkspace(this.d.dir, id)
    const box = this.box(id, ws, limits, true)
    mkdirSync(box.outDir, { recursive: true })
    // The workspace's folders, its output folder among them.
    const forget = () => discardWorkspace(this.d.dir, id)
    let args: string[]
    try {
      args = sandboxArgs(box.name, ws, limits, box.outDir)
    } catch (e) {
      forget()
      throw new SandboxError((e as Error).message)
    }
    const r = await this.exec(labelled(args))
    if (r.code !== 0 || this.ended) {
      await this.exec(["rm", "-f", box.name])
      forget()
      throw new SandboxError(
        r.code !== 0 ? `Docker did not start the sandbox: ${lastLine(r.stderr) || `exit ${r.code}`}` : "The task ended while the sandbox was starting.",
      )
    }
    getDb()
      .prepare("INSERT INTO sandboxes (id, project_id, created_by, limits, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, this.d.projectId, taskId ?? null, JSON.stringify(limits), Date.now())
    this.watch(box)
    this.boxes.set(id, box)
    this.event("sandbox.created", `Created sandbox ${id}: ${describeLimits(limits)}`, { sandbox: id, ...limits }, taskId, box)
    return box
  }

  /** The sandbox by id, refusing one this task does not have or that was stopped (R2.8). */
  usable(id: string): Box {
    const box = this.boxes.get(id)
    if (!box) throw new SandboxError(`There is no sandbox ${id} in this project; create one with sandbox_create.`)
    if (box.stopped) throw new SandboxError(`Sandbox ${id} was stopped: ${box.stopped}. Destroy it and create another.`)
    return box
  }

  /**
    The sandbox, running: one recorded by an earlier run of the task is started, or created again over its folders
    when Docker no longer has it (specs/task-persistence R3.5); the notice says what the orchestrator lost.
  */
  async open(id: string): Promise<{ box: Box; notice: string }> {
    const box = this.usable(id)
    if (box.up) return { box, notice: "" }
    let created: boolean
    try {
      mkdirSync(box.outDir, { recursive: true })
      ;({ created } = await bringUp((args, t, input) => this.exec(args, t, input), box.name, sandboxArgs(box.name, box.ws, box.limits, box.outDir)))
    } catch (e) {
      throw new SandboxError(`Sandbox ${id} could not be brought up again: ${(e as Error).message}`)
    }
    box.up = true
    this.watch(box)
    this.event(
      "sandbox.reopened",
      created ? `Created sandbox ${id} again over its folders` : `Started sandbox ${id} again`,
      { sandbox: id, created },
      undefined,
      box,
    )
    return { box, notice: created ? recreated(id) : "" }
  }

  /** Copy files from the source folder and the scratch into /work, all or none, within the disk left (R2.1–R2.3). */
  async copy(id: string, requested: string[], prepared: PreparedFile[], taskId?: string): Promise<CopiedFile[] & { notice?: string }> {
    const { box, notice } = await this.open(id)
    const disk = box.limits.diskMb
    const used = disk === undefined ? 0 : await this.usage(box)
    // A size that cannot be told does not block a copy; the watch stops the sandbox if it passes the limit.
    const left = disk === undefined ? Infinity : Math.max(0, disk * MB - (used ?? 0))
    const files: CopiedFile[] & { notice?: string } = addFiles(box.ws, this.d.sourceRoot, requested, prepared, left, `${disk} MB disk limit of sandbox ${id}`)
    this.event(
      "sandbox.copy",
      `Copied ${files.length} file(s) into sandbox ${id}`,
      { sandbox: id, files: files.map((f) => ({ path: f.path, op: "copy" })), sha256: Object.fromEntries(files.map((f) => [f.path, f.sha256])) },
      taskId,
      box,
    )
    await this.checkDisk(box)
    if (notice) files.notice = notice
    return files
  }

  /** Run a command as root in /work, stopped at its time limit, its output capped (R2.4). */
  async run(id: string, command: string, timeoutS = COMMAND_DEFAULT_S, taskId?: string): Promise<{ output: string; exitCode: number; truncated: boolean }> {
    const { box, notice } = await this.open(id)
    const limit = Math.min(Math.max(1, Math.floor(timeoutS)), COMMAND_MAX_S)
    const r = await this.exec(["exec", "-w", "/work", box.name, "timeout", "-s", "KILL", String(limit), "sh", "-c", command], (limit + 10) * 1000)
    let output = (notice ? `${notice} ` : "") + r.stdout.toString("utf8") + r.stderr
    const truncated = r.overflow === true || output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    this.event(
      "sandbox.exec",
      `Ran in sandbox ${id}: ${command.slice(0, 120)}`,
      { sandbox: id, command, exitCode: r.code, output: output.slice(0, 4000) },
      taskId,
      box,
    )
    await this.checkDisk(box)
    if (box.stopped) output += `\n[Sandbox ${id} was stopped: ${box.stopped}]`
    return { output, exitCode: r.code, truncated }
  }

  /**
    Bytes the sandbox uses: its container's writable layer plus its workspace and its output folder, both on the host
    (R3.1, specs/rea-native R2.4), or null when any cannot be told.
  */
  async usage(box: Box): Promise<number | null> {
    const r = await this.exec(["container", "inspect", "--size", "--format", "{{.SizeRw}}", box.name])
    const layer = r.code === 0 ? Number(r.stdout.toString("utf8").trim()) : NaN
    const work = folderSize(box.ws.workspace)
    const out = folderSize(box.outDir)
    return Number.isFinite(layer) && work !== null && out !== null ? layer + work + out : null
  }

  /** Measure the disk and stop the sandbox past its limit (R3.2, R3.3); a stopped sandbox is not measured again. */
  async checkDisk(box: Box): Promise<void> {
    const disk = box.limits.diskMb
    if (disk === undefined || box.stopped || !box.up || !this.boxes.has(box.id)) return
    const used = await this.usage(box)
    // Destroyed while measured, or not measurable this time: the next check decides.
    if (used === null || used <= disk * MB || box.stopped || !this.boxes.has(box.id)) return
    const usedMb = Math.ceil(used / MB)
    box.stopped = `it used ${usedMb} MB of disk, past its ${disk} MB limit`
    if (box.timer) clearInterval(box.timer)
    box.timer = null
    await this.exec(["kill", box.name])
    this.event("sandbox.stopped", `Stopped sandbox ${box.id}: ${box.stopped}`, { sandbox: box.id, usedMb, diskMb: box.limits.diskMb }, undefined, box)
  }

  /** Hold the sandbox, running, for one delegation; refused while another runs in it (specs/specialist-sandbox R4.2). */
  async hold(id: string): Promise<{ box: Box; release: () => Promise<void> }> {
    const box = this.usable(id)
    if (box.busy) throw new SandboxError(`Sandbox ${id} is already running a delegation; wait for it to end.`)
    box.busy = true
    try {
      await this.open(id)
    } catch (e) {
      box.busy = false
      throw e
    }
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

  /**
    Remove the sandbox's container and its record, keeping its folders for the task (R2.5, specs/task-persistence
    R4.3). The orchestrator cannot remove one a delegation runs in.
  */
  async destroy(id: string, taskId?: string): Promise<void> {
    const box = this.boxes.get(id)
    if (!box) throw new SandboxError(`There is no sandbox ${id} in this project.`)
    if (box.busy) throw new SandboxError(`Sandbox ${id} is running a delegation; destroy it once the delegation ends.`)
    this.forget(box)
    await this.exec(["rm", "-f", box.name])
    getDb().prepare("DELETE FROM sandboxes WHERE id = ?").run(id)
    this.event("sandbox.destroyed", `Destroyed sandbox ${id}`, { sandbox: id }, taskId, box)
  }

  private forget(box: Box) {
    this.boxes.delete(box.id)
    if (box.timer) clearInterval(box.timer)
    box.timer = null
  }

  /** Stop every running sandbox of the project, keeping it, its record and its folders (R2.6, specs/task-persistence R3.4). */
  async stopAll(): Promise<void> {
    this.ended = true
    const up = [...this.boxes.values()].filter((b) => b.up)
    for (const box of up) {
      if (box.timer) clearInterval(box.timer)
      box.timer = null
      box.up = false
    }
    if (up.length) await this.exec(["stop", "-t", "2", ...up.map((b) => b.name)])
  }

  /**
    Remove every container of a project being deleted, every one its records name included (specs/projects R3.2);
    throws, keeping the records, when Docker fails to remove one it still has.
  */
  async removeAll(): Promise<void> {
    this.ended = true
    for (const box of [...this.boxes.values()]) this.forget(box)
    const recorded = (getDb().prepare("SELECT id FROM sandboxes WHERE project_id = ?").all(this.d.projectId) as Record<string, unknown>[]).map((r) =>
      sandboxName(String(r.id)),
    )
    if (recorded.length) {
      const r = await this.exec(["rm", "-f", ...recorded])
      if (r.code !== 0 && !/No such container/i.test(r.stderr)) throw new Error(`The project's sandboxes could not be removed: ${lastLine(r.stderr)}`)
    }
    getDb().prepare("DELETE FROM sandboxes WHERE project_id = ?").run(this.d.projectId)
  }

  ids(): string[] {
    return [...this.boxes.keys()]
  }

  /** Stop, and keep, every sandbox a previous run of the app left running (R2.7, specs/task-persistence R3.4). */
  static async sweep(exec: ExecBuffer): Promise<number> {
    const r = await exec(["ps", "-q", "--filter", "name=^hfr-sbx-"])
    const ids = r.code === 0 ? r.stdout.toString("utf8").split(/\s+/).filter(Boolean) : []
    if (ids.length) await exec(["stop", "-t", "2", ...ids])
    return ids.length
  }
}

/**
  One `SpecialistBoxes` per project while any of its tasks is open, so the one-delegation-at-a-time rule holds across
  them (specs/projects R2.3, adr:0020-group-tasks-into-projects-that-share-their-analyses). The project owns no
  container: the last task to close stops its sandboxes, and the next task to open brings them up again.
*/
export class SandboxRegistry {
  private readonly open = new Map<string, { boxes: SpecialistBoxes; refs: number }>()
  /** a project whose last task closed, its sandboxes still stopping */
  private readonly stopping = new Map<string, Promise<void>>()
  constructor(private readonly make: (project: { id: string; folder: string; sourceRoot: string }, after?: Promise<void>) => SpecialistBoxes) {}

  acquire(project: { id: string; folder: string; sourceRoot: string }): { boxes: SpecialistBoxes; release: () => Promise<void> } {
    let entry = this.open.get(project.id)
    if (!entry) {
      // A task opening while the last one's stop is in flight waits for it, so the stop cannot take its sandbox down.
      entry = { boxes: this.make(project, this.stopping.get(project.id)), refs: 0 }
      this.open.set(project.id, entry)
    }
    entry.refs++
    const held = entry
    let released = false
    return {
      boxes: held.boxes,
      release: async () => {
        if (released) return
        released = true
        held.refs--
        if (held.refs > 0 || this.open.get(project.id) !== held) return
        this.open.delete(project.id)
        const stop = held.boxes.stopAll().finally(() => this.stopping.get(project.id) === stop && this.stopping.delete(project.id))
        this.stopping.set(project.id, stop)
        await stop
      },
    }
  }

  /** Remove every sandbox of a project being deleted, with an instance of its own when none is open. */
  async remove(project: { id: string; folder: string; sourceRoot: string }): Promise<void> {
    const entry = this.open.get(project.id)
    this.open.delete(project.id)
    await (entry?.boxes ?? this.make(project, this.stopping.get(project.id))).removeAll()
  }
}
