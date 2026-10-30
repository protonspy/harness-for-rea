import { randomUUID } from "node:crypto"
import type { LoginStatus, SandboxStatus } from "@shared/types"
import { CLAUDE_CODE_VERSION, dockerState, prepareImages, type Exec } from "./sandbox/docker"
import { ClaudeAccount, failureReason, loginUrl, type AccountState, type LoginInProgress, type StartAuth } from "./specialist/account"

/*
  What Settings shows and drives: Docker, the sandbox image and its preparation, and the specialist's
  Claude login (specs/desktop-ui R1.2, R1.3). Each change is pushed through `onChange`.
*/

export class SandboxService {
  private readonly exec: Exec
  private readonly sandboxDir: string
  private readonly onChange: (s: SandboxStatus) => void
  /** The automatic preparation runs once per app session; after that only the user starts one (specs/sandbox-images R3.3). */
  private prepared = false
  private current: SandboxStatus = { docker: false, dockerError: "", images: false, building: false, buildLog: "", claudeVersion: CLAUDE_CODE_VERSION }

  constructor(exec: Exec, sandboxDir: string, onChange: (s: SandboxStatus) => void = () => undefined) {
    this.exec = exec
    this.sandboxDir = sandboxDir
    this.onChange = onChange
  }

  private set(patch: Partial<SandboxStatus>): SandboxStatus {
    this.current = { ...this.current, ...patch }
    this.onChange(this.current)
    return this.current
  }

  /** The current state; the first one that finds Docker running without a ready image starts preparing it (specs/sandbox-images R3.1, R3.2). */
  async status(): Promise<SandboxStatus> {
    if (this.current.building) return this.current
    const s = this.set(await dockerState(this.exec))
    if (s.docker && !s.images && !this.prepared) return this.build().status
    return s
  }

  /** Start preparing the image; resolves with the status at the start, then pushes the outcome. */
  build(): { status: SandboxStatus; done: Promise<SandboxStatus> } {
    if (this.current.building) return { status: this.current, done: Promise.resolve(this.current) }
    this.prepared = true
    const status = this.set({
      building: true,
      buildLog: "Preparing the sandbox image: pulling the base, then adding Claude Code, downloaded and verified.\n",
    })
    const done = prepareImages(this.exec, this.sandboxDir).then(async (r) => {
      this.set({ building: false, buildLog: `${this.current.buildLog}${r.log}${r.ok ? "Done.\n" : "Preparing the image failed.\n"}`.slice(-20_000) })
      return this.status()
    })
    return { status, done }
  }
}

export class LoginService {
  private readonly account: ClaudeAccount
  private readonly onChange: (s: LoginStatus) => void
  private state: AccountState = { loggedIn: false, method: "none" }
  private login: LoginInProgress | null = null
  private text = ""
  private error = ""

  constructor(start: StartAuth, onChange: (s: LoginStatus) => void = () => undefined) {
    this.account = new ClaudeAccount(start)
    this.onChange = onChange
  }

  current(): LoginStatus {
    return {
      ...this.state,
      inProgress: !!this.login,
      url: this.login ? loginUrl(this.text) : null,
      text: this.login ? this.text.slice(-2000) : "",
      error: this.error,
    }
  }

  private changed(): LoginStatus {
    const s = this.current()
    this.onChange(s)
    return s
  }

  async refresh(): Promise<LoginStatus> {
    if (!this.login) this.state = await this.account.state()
    return this.changed()
  }

  /** Start the sign-in; `done` settles when it finishes, with the refreshed state. */
  start(): { status: LoginStatus; done: Promise<LoginStatus> } {
    if (this.login) return { status: this.current(), done: Promise.resolve(this.current()) }
    this.text = ""
    this.error = ""
    const l = this.account.login((t) => {
      this.text += t
      this.changed()
    })
    this.login = l
    const done = l.done.then(async ({ ok, text }) => {
      this.login = null
      this.text = ""
      this.state = await this.account.state()
      if (!ok || !this.state.loggedIn) this.error = failureReason(text)
      return this.changed()
    })
    return { status: this.changed(), done }
  }

  sendCode(code: string): LoginStatus {
    if (!this.login) throw new Error("No sign-in is in progress.")
    this.login.sendCode(code)
    return this.current()
  }

  cancel(): LoginStatus {
    this.login?.cancel()
    return this.current()
  }

  /** The Anthropic page to open, only while a sign-in runs. */
  url(): string | null {
    return this.login ? loginUrl(this.text) : null
  }

  async logout(): Promise<LoginStatus> {
    await this.account.logout().catch(() => undefined)
    return this.refresh()
  }
}

export const authId = () => randomUUID().slice(0, 8)
