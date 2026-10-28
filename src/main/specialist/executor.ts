import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { StreamReader, type StreamEvent, type StreamResult } from "./stream"

/*
  One specialist session (specs/claude-specialist R1): start a prepared launch — always the
  sandbox's `docker run … claude -p …` in the app, a fake CLI in tests — send turns as stream-json
  on stdin, read events from stdout, and stop it on cancel or timeout. The executor never chooses
  a binary itself, so there is no path by which the specialist runs on the host.
*/

export interface Launch {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** stop whatever the process stands for, e.g. `docker kill` its container */
  stop?: () => Promise<void>
}

export type FailureKind = "auth" | "limit" | "failed" | "cancelled" | "timeout"

export class SpecialistError extends Error {
  readonly kind: FailureKind

  constructor(kind: FailureKind, message: string) {
    super(message)
    this.name = "SpecialistError"
    this.kind = kind
  }
}

/** Turn what Claude Code reported into something the user can act on (R1.4). */
export function classifyFailure(text: string): SpecialistError {
  if (/invalid api key|please run \/login|not logged in|oauth token|authentication/i.test(text))
    return new SpecialistError("auth", "The specialist is not signed in to Claude. Sign in again in Settings.")
  if (/usage limit|hit your limit|rate.?limit|limit reached|overloaded/i.test(text)) {
    const resets = /resets?\s+(.+)/i.exec(text)?.[1]?.trim()
    return new SpecialistError("limit", `Your Claude plan's limit is reached for now${resets ? ` (resets ${resets})` : ""}.`)
  }
  return new SpecialistError("failed", `Claude Code: ${text.slice(0, 400) || "the run failed."}`)
}

export interface SessionOptions {
  onEvent?(e: StreamEvent): void
  /** every stdout line, unparsed, before it is read */
  onRaw?(line: string): void
  timeoutMs: number
  signal?: AbortSignal
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true })
  else child.kill("SIGKILL")
}

export class SpecialistSession {
  readonly reader = new StreamReader()
  private readonly child: ChildProcess
  private readonly launch: Launch
  private stderr = ""
  private pending: { resolve(r: StreamResult): void; reject(e: Error): void } | null = null
  private failure: SpecialistError | null = null
  private readonly exited: Promise<number | null>
  private readonly timer: NodeJS.Timeout
  private readonly abort: () => void
  private readonly signal?: AbortSignal

  constructor(launch: Launch, o: SessionOptions) {
    if (o.signal?.aborted) throw new SpecialistError("cancelled", "Cancelled.")
    this.launch = launch
    this.signal = o.signal
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.child.stdin?.on("error", () => undefined)
    this.child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-4000)
    })
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      o.onRaw?.(line)
      for (const e of this.reader.line(line)) {
        o.onEvent?.(e)
        if (e.kind === "result") this.settle()
      }
    })
    this.exited = new Promise((resolve) => {
      this.child.on("error", (e) => {
        this.fail(new SpecialistError("failed", `Claude Code did not start: ${e.message}`))
        resolve(null)
      })
      this.child.on("close", (code) => {
        clearTimeout(this.timer)
        this.signal?.removeEventListener("abort", this.abort)
        const last = this.stderr.trim().split("\n").pop()?.trim()
        this.fail(this.failure ?? classifyFailure(last || `Claude Code stopped without an answer (exit ${code}).`))
        resolve(code)
      })
    })
    this.timer = setTimeout(() => void this.kill("timeout"), o.timeoutMs)
    this.abort = () => void this.kill("cancelled")
    o.signal?.addEventListener("abort", this.abort, { once: true })
  }

  private settle() {
    const r = this.reader.result
    const p = this.pending
    if (!r || !p) return
    this.pending = null
    if (r.error) p.reject(classifyFailure(r.text || r.reason || this.stderr))
    else p.resolve(r)
  }

  private fail(e: SpecialistError) {
    const p = this.pending
    this.pending = null
    p?.reject(e)
  }

  /** Send one user turn; resolves with that turn's result (R1.2). */
  send(text: string): Promise<StreamResult> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.child.exitCode !== null) return Promise.reject(new SpecialistError("failed", "Claude Code is no longer running."))
    if (this.pending) return Promise.reject(new SpecialistError("failed", "A turn is already in progress."))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`)
    })
  }

  /** End stdin and wait for Claude Code to exit. */
  async close(): Promise<void> {
    this.child.stdin?.end()
    await this.exited
  }

  /** Stop the container and the process tree, reporting the session as cancelled or timed out (R1.3). */
  async kill(kind: "cancelled" | "timeout"): Promise<void> {
    if (this.failure) return
    this.failure = new SpecialistError(kind, kind === "timeout" ? "The delegation exceeded its timeout and was stopped." : "Cancelled.")
    this.fail(this.failure)
    await this.launch.stop?.().catch(() => undefined)
    killTree(this.child)
    await this.exited
  }

  get outcome(): FailureKind | null {
    return this.failure?.kind ?? null
  }
}
