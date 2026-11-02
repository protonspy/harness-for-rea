import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { posix } from "node:path"
import { BaseSandbox } from "deepagents"
import { identity, mountSource, SPECIALIST_IMAGE } from "./docker"

/*
  The orchestrator's container for one task (adr:0007-run-the-orchestrators-tools-in-a-task-container):
  the source folder bind-mounted read-only at /workspace, full internet access
  (adr:0013-give-the-sandboxes-full-internet-access), confined like the specialist's.
  DeepAgents reaches it as a sandbox backend, so its file tools and `execute` all run there through
  `docker exec`, and no tool of the orchestrator writes the user's files. It writes and runs its own code in
  /scratch (adr:0009-give-the-orchestrator-a-writable-scratch, specs/chat R6.3), bound from the task's own
  folder, and the container is stopped rather than removed when the task ends, so both outlive it until the
  task is deleted (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted).
*/

export const WORKSPACE = "/workspace"
export const SCRATCH = "/scratch"
/** Largest command output returned to the agent. */
export const OUTPUT_CAP = 100_000
const EXEC_TIMEOUT_MS = 120_000
/** A command's own time limit inside the container, under the client's, so it never outlives the call. */
const COMMAND_TIMEOUT_S = 110
/** Largest stdout kept from one `docker exec`: a file read whole, or a command's output before truncation. */
export const BUFFER_CAP = 16 * 1024 * 1024

export interface BufferResult {
  code: number
  stdout: Buffer
  stderr: string
  /** the output passed the cap and the command was stopped */
  overflow?: boolean
}

/** Runs `docker` with these arguments, feeding `input` to its stdin when given. */
export type ExecBuffer = (args: string[], timeoutMs?: number, input?: Uint8Array) => Promise<BufferResult>

export const dockerExecBuffer: ExecBuffer = (args, timeoutMs = EXEC_TIMEOUT_MS, input) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
    const out: Buffer[] = []
    let size = 0
    let overflow = false
    let stderr = ""
    const timer = setTimeout(() => child.kill(), timeoutMs)
    // The output lands in the app's own memory, outside the container's limits: stop at the cap.
    child.stdout.on("data", (c: Buffer) => {
      if (overflow) return
      out.push(c)
      size += c.length
      if (size > BUFFER_CAP) {
        overflow = true
        child.kill()
      }
    })
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += c.toString("utf8")
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: e.message, overflow })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr, overflow })
    })
  })

export function taskBoxName(taskId: string): string {
  return `hfr-orch-${taskId}`
}

/**
  `docker run` for a task's container: the source read-only at /workspace, full internet access, and root
  with a writable root filesystem so the orchestrator can install what its code needs
  (adr:0015-run-the-task-container-as-root); never privileged, never a host path but the source. No memory, CPU,
  process or size limit: /scratch and /tmp are folders on the writable root, on Docker's disk rather than in memory
  (specs/specialist-sandbox R6.1, R6.2).
*/
export function taskBoxArgs(taskId: string, sourceRoot: string, scratchDir: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    taskBoxName(taskId),
    "--hostname",
    "workspace",
    // a PID 1 that reaps what `docker exec` and `timeout` leave behind
    "--init",
    // Root with what apt, dpkg, pip and npm need, and nothing else: no NET_RAW, MKNOD or SYS_CHROOT.
    ...identity(true),
    "--mount",
    `type=bind,source=${mountSource(sourceRoot)},target=${WORKSPACE},readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "--mount",
    `type=bind,source=${mountSource(scratchDir)},target=${SCRATCH}`,
    "-w",
    WORKSPACE,
    "--entrypoint",
    "sleep",
    SPECIALIST_IMAGE,
    "infinity",
  ]
}

/** What the orchestrator reads once a container Docker had removed was created again. */
export const RESTARTED = "[The task's sandbox was created again: /scratch was kept, anything installed is gone.]"

const lastLine = (s: string) => s.trim().split("\n").pop() || ""

/** The label a container carries of the arguments it was created with, so one made by an older app is not reused. */
export const CONFIG_LABEL = "hfr.config"

/** `docker run` arguments with the label of their own fingerprint, which covers the image and every flag and mount. */
export function labelled(args: string[]): string[] {
  const fingerprint = createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 16)
  return [...args.slice(0, 2), "--label", `${CONFIG_LABEL}=${fingerprint}`, ...args.slice(2)]
}

/**
  Bring a task's container up: start it when Docker still has it as these arguments would make it, or create it over
  the same folders when Docker no longer has it or it was made otherwise — by an older app with another image or
  boundary (specs/task-persistence R3.5). Returns whether it was created, or throws with Docker's reason.
*/
export async function bringUp(exec: ExecBuffer, name: string, args: string[]): Promise<{ created: boolean }> {
  const run = labelled(args)
  const want = run[3]
  const has = await exec(["inspect", "--format", `${CONFIG_LABEL}={{index .Config.Labels "${CONFIG_LABEL}"}}`, name])
  if (has.code === 0 && has.stdout.toString("utf8").trim() === want) {
    const started = await exec(["start", name])
    if (started.code === 0) return { created: false }
    if (!/No such container/i.test(started.stderr)) throw new Error(lastLine(started.stderr) || `exit ${started.code}`)
  } else if (has.code === 0) {
    // made with another image or boundary: replaced, its folders kept
    const gone = await exec(["rm", "-f", name])
    if (gone.code !== 0 && !/No such container/i.test(gone.stderr)) throw new Error(lastLine(gone.stderr) || `exit ${gone.code}`)
  }
  const r = await exec(run)
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `exit ${r.code}`)
  return { created: true }
}

export class TaskBox extends BaseSandbox {
  readonly id: string
  private readonly exec: ExecBuffer
  /** brings the container up again when it stopped or went away; whether it had to be created, or null when it could not */
  private readonly revive: () => Promise<{ created: boolean } | null>
  private disposed = false
  /** the container was created rather than started when the task opened: what was installed is gone */
  created = false

  constructor(exec: ExecBuffer, taskId: string, revive: () => Promise<{ created: boolean } | null> = async () => null) {
    super()
    this.exec = exec
    this.id = taskBoxName(taskId)
    this.revive = revive
  }

  /**
    Bring the task's container up, started again when Docker still has it (specs/task-persistence R3.5); throws with
    Docker's reason when it cannot. A container that stops or goes away later is brought up again.
  */
  static async start(exec: ExecBuffer, taskId: string, sourceRoot: string, scratchDir: string): Promise<TaskBox> {
    mkdirSync(scratchDir, { recursive: true })
    const up = () => bringUp(exec, taskBoxName(taskId), taskBoxArgs(taskId, sourceRoot, scratchDir))
    let first: { created: boolean }
    try {
      first = await up()
    } catch (e) {
      throw new Error(`The task's sandbox did not start: ${(e as Error).message}`, { cause: e })
    }
    const box = new TaskBox(exec, taskId, () => up().catch(() => null))
    box.created = first.created
    return box
  }

  /**
    One `docker exec` into the container. When the container stopped or is gone — stopped by the app's start, removed
    by Docker or by a crash — it is brought up again once and the call retried; /scratch is the task's folder, so it
    is still there.
  */
  private async inBox(args: string[], input?: Uint8Array): Promise<BufferResult & { restarted?: boolean }> {
    const r = await this.exec(args, undefined, input)
    if (this.disposed || r.code === 0 || !/No such container|is not running/i.test(r.stderr)) return r
    const up = await this.revive()
    if (!up) return r
    return { ...(await this.exec(args, undefined, input)), restarted: up.created }
  }

  async execute(command: string) {
    const r = await this.inBox(["exec", this.id, "timeout", "-s", "KILL", String(COMMAND_TIMEOUT_S), "sh", "-c", command])
    let output = (r.restarted ? RESTARTED + " " : "") + r.stdout.toString("utf8") + r.stderr
    const truncated = r.overflow === true || output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    return { output, exitCode: r.code, truncated }
  }

  /** Writes land in /scratch only; the source is mounted read-only and nothing is uploaded to it (specs/chat R6.4). */
  async uploadFiles(files: Array<[string, Uint8Array]>) {
    const out = []
    for (const [path, content] of files) {
      const inScratch = path.startsWith("/") && posix.normalize(path).startsWith(`${SCRATCH}/`) && posix.normalize(path) === path
      const r = inScratch ? await this.inBox(["exec", "-i", this.id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], content) : null
      out.push({ path, error: r?.code === 0 ? null : ("permission_denied" as const) })
    }
    return out
  }

  async downloadFiles(paths: string[]) {
    const out = []
    for (const path of paths) {
      const r = await this.inBox(["exec", this.id, "cat", "--", path])
      out.push(
        r.code === 0 && !r.overflow
          ? { path, content: new Uint8Array(r.stdout), error: null }
          : { path, content: null, error: /Is a directory/.test(r.stderr) ? ("is_directory" as const) : ("file_not_found" as const) },
      )
    }
    return out
  }

  /**
    Stop, and keep, the task containers a gone process left running, e.g. after a crash; those of a task a live app
    has open are left alone (specs/shared-data-folder R2.3). `ownedByLive` answers for a task id.
  */
  static async sweep(exec: ExecBuffer, ownedByLive: (taskId: string) => boolean = () => false): Promise<number> {
    // Running only: their tasks were interrupted, and a stopped container keeps what was installed in it.
    const r = await exec(["ps", "--filter", "name=^hfr-orch-", "--format", "{{.Names}}"])
    const names =
      r.code === 0
        ? r.stdout
            .toString("utf8")
            .split(/\s+/)
            .filter((n) => n.startsWith("hfr-orch-"))
        : []
    const stale = names.filter((n) => !ownedByLive(n.slice("hfr-orch-".length)))
    if (stale.length) await exec(["stop", "-t", "2", ...stale])
    return stale.length
  }

  /** Stop the container and keep it, with what was installed, for when the task reopens (specs/task-persistence R3.4). */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.exec(["stop", "-t", "2", this.id])
  }

  /** Remove the container of a task being deleted; one already gone is not an error (R4.1). */
  static async remove(exec: ExecBuffer, taskId: string): Promise<void> {
    const r = await exec(["rm", "-f", taskBoxName(taskId)])
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) throw new Error(`The task's container could not be removed: ${lastLine(r.stderr)}`)
  }
}
