import { spawn } from "node:child_process"
import { posix } from "node:path"
import { BaseSandbox } from "deepagents"
import { mountSource, SPECIALIST_IMAGE, type Limits } from "./docker"

/*
  The orchestrator's container for one task (adr:0007-run-the-orchestrators-tools-in-a-task-container):
  the source folder bind-mounted read-only at /workspace, full internet access
  (adr:0013-give-the-sandboxes-full-internet-access), confined like the specialist's.
  DeepAgents reaches it as a sandbox backend, so its file tools and `execute` all run there through
  `docker exec`, and no tool of the orchestrator writes the user's files. Its one writable place is
  /scratch, a tmpfs gone with the container, where it writes and runs its own code
  (adr:0009-give-the-orchestrator-a-writable-scratch, specs/chat R6.3).
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

/** The capabilities the task container keeps as root, enough to install packages (adr:0014-run-the-task-container-as-root). */
export const INSTALL_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"]

export function taskBoxName(taskId: string): string {
  return `hfr-orch-${taskId}`
}

/**
  `docker run` for a task's container: the source read-only at /workspace, full internet access, and root
  with a writable root filesystem so the orchestrator can install what its code needs
  (adr:0014-run-the-task-container-as-root); never privileged, never a host path but the source.
*/
export function taskBoxArgs(taskId: string, sourceRoot: string, limits: Limits): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    taskBoxName(taskId),
    "--hostname",
    "workspace",
    "--user",
    "0:0",
    // What apt, dpkg, pip and npm need as root, and nothing else: no NET_RAW, MKNOD or SYS_CHROOT.
    "--cap-drop",
    "ALL",
    ...INSTALL_CAPS.flatMap((c) => ["--cap-add", c]),
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    `${SCRATCH}:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700`,
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pidsLimit),
    "--mount",
    `type=bind,source=${mountSource(sourceRoot)},target=${WORKSPACE},readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "-w",
    WORKSPACE,
    "--entrypoint",
    "sleep",
    SPECIALIST_IMAGE,
    "infinity",
  ]
}

export class TaskBox extends BaseSandbox {
  readonly id: string
  private readonly exec: ExecBuffer

  constructor(exec: ExecBuffer, taskId: string) {
    super()
    this.exec = exec
    this.id = taskBoxName(taskId)
  }

  /** Start the task's container; throws with Docker's reason when it cannot. */
  static async start(exec: ExecBuffer, taskId: string, sourceRoot: string, limits: Limits): Promise<TaskBox> {
    const r = await exec(taskBoxArgs(taskId, sourceRoot, limits))
    if (r.code !== 0) throw new Error(`The task's sandbox did not start: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`)
    return new TaskBox(exec, taskId)
  }

  async execute(command: string) {
    const r = await this.exec(["exec", this.id, "timeout", "-s", "KILL", String(COMMAND_TIMEOUT_S), "sh", "-c", command])
    let output = r.stdout.toString("utf8") + r.stderr
    const truncated = r.overflow === true || output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    return { output, exitCode: r.code, truncated }
  }

  /** Writes land in /scratch only; the source is mounted read-only and nothing is uploaded to it (specs/chat R6.4). */
  async uploadFiles(files: Array<[string, Uint8Array]>) {
    const out = []
    for (const [path, content] of files) {
      const inScratch = path.startsWith("/") && posix.normalize(path).startsWith(`${SCRATCH}/`) && posix.normalize(path) === path
      const r = inScratch
        ? await this.exec(["exec", "-i", this.id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], undefined, content)
        : null
      out.push({ path, error: r?.code === 0 ? null : ("permission_denied" as const) })
    }
    return out
  }

  async downloadFiles(paths: string[]) {
    const out = []
    for (const path of paths) {
      const r = await this.exec(["exec", this.id, "cat", "--", path])
      out.push(
        r.code === 0 && !r.overflow
          ? { path, content: new Uint8Array(r.stdout), error: null }
          : { path, content: null, error: /Is a directory/.test(r.stderr) ? ("is_directory" as const) : ("file_not_found" as const) },
      )
    }
    return out
  }

  /** Remove every task container a previous run of the app left behind, e.g. after a crash. */
  static async sweep(exec: ExecBuffer): Promise<number> {
    const r = await exec(["ps", "-aq", "--filter", "name=^hfr-orch-"])
    const ids = r.code === 0 ? r.stdout.toString("utf8").split(/\s+/).filter(Boolean) : []
    if (ids.length) await exec(["rm", "-f", ...ids])
    return ids.length
  }

  /** Remove the container; one already gone is not an error. */
  async dispose(): Promise<void> {
    await this.exec(["rm", "-f", this.id])
  }
}
