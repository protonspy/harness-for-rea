import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"

/*
  The user's Claude login, always inside the sandbox image on its config volume (specs/claude-specialist
  R3; adr:0003-authenticate-the-specialist-with-the-users-claude-plan). The app never reads the
  credential: it asks `claude auth status --json`, runs `claude auth login --claudeai`, exposes only
  the Anthropic page that login prints, and passes on the code the user pastes. Ported from
  study-lab's `account.ts`.
*/

export interface AccountState {
  loggedIn: boolean
  method: string
  plan?: string
  email?: string
}

export interface ChildLike {
  stdout: Readable | null
  stderr: Readable | null
  stdin: Writable | null
  kill(): boolean
  on(event: "close", fn: (code: number | null) => void): unknown
  on(event: "error", fn: (err: Error) => void): unknown
}

/** Start `claude auth <sub…>` — in the app, `docker run … claude auth …`. */
export type StartAuth = (sub: string[]) => ChildLike

/**
  Spawn `command` with the arguments `prepare` gives for each auth command. Killing the child also
  calls `stop`, since killing the `docker` client does not stop the container it started.
*/
export function spawnStart(command: string, prepare: (sub: string[]) => { args: string[]; stop?: () => void }): StartAuth {
  return (sub) => {
    const p = prepare(sub)
    const child = spawn(command, p.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const kill = child.kill.bind(child)
    child.kill = () => {
      p.stop?.()
      return kill()
    }
    return child
  }
}

/** Strip terminal escapes (colour, OSC 8 links) and control characters. */
export function cleanText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

const ANTHROPIC_HOSTS = ["claude.com", "claude.ai", "anthropic.com"]

export function isAnthropicUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && ANTHROPIC_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/** The sign-in address the login printed, when it is Anthropic's. */
export function loginUrl(text: string): string | null {
  for (const m of cleanText(text).matchAll(/https:\/\/[^\s"'<>]+/g)) if (isAnthropicUrl(m[0])) return m[0]
  return null
}

export function validCode(code: string): boolean {
  return /^[A-Za-z0-9#_\-.~]{8,512}$/.test(code.trim())
}

/** `claude auth status --json`, which the pinned CLI prints over several lines. */
export function parseStatus(out: string): AccountState {
  const d = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as {
    loggedIn?: unknown
    authMethod?: unknown
    subscriptionType?: unknown
    email?: unknown
  }
  return {
    loggedIn: d.loggedIn === true,
    method: typeof d.authMethod === "string" ? d.authMethod : "none",
    plan: typeof d.subscriptionType === "string" ? d.subscriptionType : undefined,
    email: typeof d.email === "string" ? d.email : undefined,
  }
}

const INSTRUCTIONS = [/^Opening browser/i, /didn't open/i, /^https:\/\//]
/** The prompt Claude Code prints without a newline, so its outcome follows on the same line. */
const PROMPT = /^Paste code here if prompted\s*>\s*/i

/** The last line Claude Code wrote that says what went wrong. */
export function failureReason(text: string): string {
  const lines = cleanText(text)
    .split("\n")
    .map((l) => l.trim().replace(PROMPT, ""))
    .filter((l) => l && !INSTRUCTIONS.some((r) => r.test(l)))
  return lines.pop() ?? "The sign-in did not finish."
}

export interface LoginInProgress {
  sendCode(code: string): void
  cancel(): void
  done: Promise<{ ok: boolean; text: string }>
}

function collect(child: ChildLike): Promise<{ code: number | null; out: string }> {
  let out = ""
  child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")))
  return new Promise((resolve) => {
    child.on("error", () => resolve({ code: -1, out }))
    child.on("close", (code) => resolve({ code, out }))
  })
}

export class ClaudeAccount {
  private readonly start: StartAuth

  constructor(start: StartAuth) {
    this.start = start
  }

  async state(): Promise<AccountState> {
    try {
      const child = this.start(["status", "--json"])
      child.stdin?.end()
      const { out } = await collect(child)
      return parseStatus(out)
    } catch {
      return { loggedIn: false, method: "none" }
    }
  }

  async logout(): Promise<void> {
    const child = this.start(["logout"])
    child.stdin?.end()
    await collect(child)
  }

  /** Start the subscription sign-in. `onText` gets what Claude Code writes, cleaned. */
  login(onText: (text: string) => void): LoginInProgress {
    const child = this.start(["login", "--claudeai"])
    let text = ""
    const listen = (chunk: Buffer) => {
      const t = cleanText(chunk.toString("utf8"))
      text += t
      onText(t)
    }
    child.stdout?.on("data", listen)
    child.stderr?.on("data", listen)
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      child.on("error", (e) => resolve({ ok: false, text: `${text}${e.message}` }))
      child.on("close", (code) => resolve({ ok: code === 0, text }))
    })
    return {
      sendCode: (code) => {
        if (!validCode(code)) throw new Error("That code does not look right. Copy it again from the Anthropic page.")
        child.stdin?.write(`${code.trim()}\n`)
      },
      cancel: () => {
        child.kill()
      },
      done,
    }
  }
}
