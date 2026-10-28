import { spawn } from "node:child_process"
import { BaseSandbox } from "deepagents"
import { mountSource, SPECIALIST_IMAGE, type Limits } from "./docker"

/*
  The orchestrator's container for one task (adr:0007-run-the-orchestrators-tools-in-a-task-container):
  the source folder bind-mounted read-only at /workspace, no network, confined like the specialist's.
  DeepAgents reaches it as a sandbox backend, so its file tools and `execute` all run there through
  `docker exec`, and no tool of the orchestrator writes the user's files.
*/

export const WORKSPACE = "/workspace"
/** Largest command output returned to the agent. */
export const OUTPUT_CAP = 100_000
const EXEC_TIMEOUT_MS = 120_000

export interface BufferResult {
  code: number
  stdout: Buffer
  stderr: string
}

export type ExecBuffer = (args: string[], timeoutMs?: number) => Promise<BufferResult>

export const dockerExecBuffer: ExecBuffer = (args, timeoutMs = EXEC_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = []
    let stderr = ""
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr })
    })
  })

export function taskBoxName(taskId: string): string {
  return `hfr-orch-${taskId}`
}

/** `docker run` for a task's container: the source read-only at /workspace, no network, no privileges. */
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
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pidsLimit),
    "--network",
    "none",
    "--mount",
    `type=bind,source=${mountSource(sourceRoot)},target=${WORKSPACE},readonly`,
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
    const r = await this.exec(["exec", this.id, "sh", "-c", command])
    let output = r.stdout.toString("utf8") + r.stderr
    const truncated = output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    return { output, exitCode: r.code, truncated }
  }

  /** The source is mounted read-only: nothing is ever uploaded. */
  async uploadFiles(files: Array<[string, Uint8Array]>) {
    return files.map(([path]) => ({ path, error: "permission_denied" as const }))
  }

  async downloadFiles(paths: string[]) {
    const out = []
    for (const path of paths) {
      const r = await this.exec(["exec", this.id, "cat", "--", path])
      out.push(
        r.code === 0
          ? { path, content: new Uint8Array(r.stdout), error: null }
          : { path, content: null, error: /Is a directory/.test(r.stderr) ? ("is_directory" as const) : ("file_not_found" as const) },
      )
    }
    return out
  }

  /** Remove the container; one already gone is not an error. */
  async dispose(): Promise<void> {
    await this.exec(["rm", "-f", this.id])
  }
}
