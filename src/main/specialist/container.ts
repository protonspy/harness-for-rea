import { posix } from "node:path"
import { BaseSandbox } from "deepagents"
import { OUTPUT_CAP, type ExecBuffer } from "../sandbox/taskbox"

/*
  Where the DeepAgents specialist's tools run (specs/specialist-providers R2.2): a sandbox backend over `docker exec`
  into the delegation's container — its own, or the orchestrator's sandbox — working in /work. DeepAgents' file tools
  and `execute` all land there, as root, under the mounts the container has: /work is read-only unless the step
  modifies, and nothing runs on the host.
*/

/** A command's time limit, as a command the orchestrator runs in a sandbox gets by default. */
export const COMMAND_TIMEOUT_S = 600

export class ContainerBackend extends BaseSandbox {
  readonly id: string
  private readonly exec: ExecBuffer
  private readonly timeoutS: number

  constructor(exec: ExecBuffer, container: string, timeoutS = COMMAND_TIMEOUT_S) {
    super()
    this.exec = exec
    this.id = container
    this.timeoutS = timeoutS
  }

  async execute(command: string) {
    // The command's own limit inside the container, under the client's, so it never outlives the call.
    const r = await this.exec(
      ["exec", "-w", "/work", this.id, "timeout", "-s", "KILL", String(this.timeoutS), "sh", "-c", command],
      (this.timeoutS + 15) * 1000,
    )
    let output = r.stdout.toString("utf8") + r.stderr
    const truncated = r.overflow === true || output.length > OUTPUT_CAP
    if (truncated) output = output.slice(0, OUTPUT_CAP)
    return { output, exitCode: r.code, truncated }
  }

  /** Written as root wherever the container lets it: a read-only /work refuses the write, as it refuses the shell's. */
  async uploadFiles(files: Array<[string, Uint8Array]>) {
    const out = []
    for (const [path, content] of files) {
      const ok = path.startsWith("/") && posix.normalize(path) === path
      const r = ok ? await this.exec(["exec", "-i", this.id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], undefined, content) : null
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
}
