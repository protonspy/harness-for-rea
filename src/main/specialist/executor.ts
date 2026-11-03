import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { MCP_TOOL_TIMEOUT_MS } from "../sandbox/docker"
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

/** `refused`: a safeguard refusal under the usage policy, never a failure to retry (specs/specialist-lifecycle R2.1) */
export type FailureKind = "auth" | "limit" | "refused" | "failed" | "cancelled" | "timeout"

/** What the user and the orchestrator read for a safeguard refusal. */
export const REFUSED = "The specialist declined this step under its usage policy (a safeguard refusal)."

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
  /**
    The inactivity timeout (R1.3, R1.6): how long a turn may go with no output line and no tool call open before the
    delegation is stopped. Time between turns and inside a tool call — a question to the user, an integration call, a
    long analysis — never counts; there is no wall-clock limit.
  */
  idleMs: number
  /**
    How long a tool call may stay open with no other call opening or closing before the delegation is stopped (R1.7):
    Claude Code's own MCP tool timeout, so it only catches a call that never answers, or an id the stream never closes.
  */
  openCeilingMs?: number
  /** How long the CLI may take to exit once the delegation ends before it is stopped (R1.8). */
  exitGraceMs?: number
  signal?: AbortSignal
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true })
  else child.kill("SIGKILL")
}

/** A duration in whole minutes, or seconds below one. */
/** The tools that run a subagent rather than doing work themselves. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"])

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)

export class SpecialistSession {
  readonly reader = new StreamReader()
  private readonly child: ChildProcess
  private readonly launch: Launch
  private stderr = ""
  private pending: { resolve(r: StreamResult): void; reject(e: Error): void } | null = null
  private failure: SpecialistError | null = null
  private readonly exited: Promise<number | null>
  private timer: NodeJS.Timeout | null = null
  private armedFor: "idle" | "open" = "idle"
  private readonly idleMs: number
  private readonly openCeilingMs: number
  private readonly exitGraceMs: number
  /** the tool calls started and not yet answered */
  private readonly open = new Set<string>()
  private readonly abort: () => void
  private readonly signal?: AbortSignal

  constructor(launch: Launch, o: SessionOptions) {
    if (o.signal?.aborted) throw new SpecialistError("cancelled", "Cancelled.")
    this.launch = launch
    this.signal = o.signal
    this.idleMs = o.idleMs
    this.openCeilingMs = o.openCeilingMs ?? MCP_TOOL_TIMEOUT_MS
    this.exitGraceMs = o.exitGraceMs ?? 30_000
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.child.stdin?.on("error", () => undefined)
    this.child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-4000)
    })
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      o.onRaw?.(line)
      // Only a line Claude Code means is activity: a blank, unparsed or unknown one keeps nothing alive (R1.6).
      let live = false
      const before = this.open.size
      for (const e of this.reader.line(line)) {
        const id = typeof e.payload?.callId === "string" ? e.payload.callId : ""
        if (e.kind !== "unknown") live = true
        // A subagent's own call stays open for its whole run; its calls inside count instead, so a stalled subagent still times out.
        if (e.kind === "tool.call" && id && !SUBAGENT_TOOLS.has(String(e.payload.tool))) this.open.add(id)
        else if (e.kind === "tool.result") this.open.delete(id)
        else if (e.kind === "result") this.open.clear()
        o.onEvent?.(e)
        if (e.kind === "result") this.settle()
      }
      if (live) this.arm(this.open.size !== before)
    })
    this.exited = new Promise((resolve) => {
      this.child.on("error", (e) => {
        this.fail(new SpecialistError("failed", `Claude Code did not start: ${e.message}`))
        resolve(null)
      })
      this.child.on("close", (code) => {
        this.disarm()
        this.signal?.removeEventListener("abort", this.abort)
        const last = this.stderr.trim().split("\n").pop()?.trim()
        this.fail(this.failure ?? classifyFailure(last || `Claude Code stopped without an answer (exit ${code}).`))
        resolve(code)
      })
    })
    this.abort = () => void this.kill("cancelled")
    o.signal?.addEventListener("abort", this.abort, { once: true })
  }

  /**
    Restarts the inactivity timer while a turn waits with no tool call open (R1.6); with one open, the ceiling of R1.7,
    restarted only when a call opens or closes, so a heartbeat of a call that never answers does not hold it off.
  */
  private arm(openChanged = true) {
    if (!this.pending || this.failure) return this.disarm()
    if (this.open.size && this.timer && !openChanged && this.armedFor === "open") return
    this.disarm()
    this.armedFor = this.open.size ? "open" : "idle"
    this.timer = setTimeout(() => void this.kill("timeout"), this.open.size ? this.openCeilingMs : this.idleMs)
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private settle() {
    const r = this.reader.result
    const p = this.pending
    if (!r || !p) return
    this.pending = null
    this.disarm()
    // A refusal is read from the API's stop reason, or from Claude Code's own error line on a failed turn — never from
    // anything the specialist could be steered to write.
    if (r.refused || (r.error && /^API Error:[^\n]*usage policy/i.test(r.text))) p.reject(new SpecialistError("refused", REFUSED))
    else if (r.error) p.reject(classifyFailure(r.text || r.reason || this.stderr))
    else p.resolve(r)
  }

  private fail(e: SpecialistError) {
    const p = this.pending
    this.pending = null
    this.disarm()
    p?.reject(e)
  }

  /** Send one user turn; resolves with that turn's result (R1.2). */
  send(text: string): Promise<StreamResult> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.child.exitCode !== null) return Promise.reject(new SpecialistError("failed", "Claude Code is no longer running."))
    if (this.pending) return Promise.reject(new SpecialistError("failed", "A turn is already in progress."))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.arm()
      this.child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`)
    })
  }

  /** End stdin and wait for Claude Code to exit. */
  async close(): Promise<void> {
    this.child.stdin?.end()
    // A CLI that does not exit once its stdin ends is stopped, so a finished delegation never hangs (R1.8).
    const late = setTimeout(() => {
      void this.launch.stop?.().catch(() => undefined)
      killTree(this.child)
    }, this.exitGraceMs)
    late.unref?.()
    await this.exited
    clearTimeout(late)
  }

  /** Stop the container and the process tree, reporting the session as cancelled or timed out (R1.3). */
  async kill(kind: "cancelled" | "timeout"): Promise<void> {
    if (this.failure) return
    this.failure = new SpecialistError(
      kind,
      kind === "timeout"
        ? this.armedFor === "open"
          ? `A tool call of the specialist stayed open for ${minutes(this.openCeilingMs)} and the delegation was stopped.`
          : `The specialist was inactive for ${minutes(this.idleMs)} and was stopped.`
        : "Cancelled.",
    )
    this.fail(this.failure)
    await this.launch.stop?.().catch(() => undefined)
    killTree(this.child)
    await this.exited
  }

  get outcome(): FailureKind | null {
    return this.failure?.kind ?? null
  }
}
