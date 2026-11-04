import type { HopperSignIn } from "@shared/types"

/*
  Signing in to Hopper without pasting a key (specs/specialist-providers R3): Hopper's agent registration, where the app
  registers with the user's email, the user confirms a six-digit code on Hopper's own page, and the app polls Hopper's
  token endpoint until it hands back an `sk_hopper_` key, which goes to the OS keychain like a pasted one. No client id,
  no redirect: the code goes into Hopper's page, never back to the app.
*/

export const HOPPER_ORIGIN = "https://withhopper.com"
export const REGISTER_URL = `${HOPPER_ORIGIN}/agent/identity`
export const TOKEN_URL = `${HOPPER_ORIGIN}/oauth2/token`
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim"
/** How long to wait after Hopper says to slow down. */
export const SLOW_DOWN_MS = 60_000

/** Whether an address is a page of Hopper's own site, the only kind the sign-in opens (R3.4). */
export function isHopperPage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === HOPPER_ORIGIN && !u.username && !u.password
  } catch {
    return false
  }
}

/** The part of fetch the sign-in uses. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface HopperSignInDeps {
  fetch?: Fetch
  /** opens Hopper's page in the user's browser; false when it could not */
  open(url: string): Promise<boolean>
  /** keeps the key as Hopper's, in the OS keychain */
  save(key: string): Promise<void>
  wait?(ms: number): Promise<void>
}

const IDLE: HopperSignIn = { inProgress: false, done: false, code: "", url: "", error: "" }

export class HopperSignInService {
  private state: HopperSignIn = IDLE
  private run = 0
  private readonly d: Required<HopperSignInDeps>

  constructor(d: HopperSignInDeps) {
    this.d = {
      fetch: d.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      wait: d.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      open: d.open,
      save: d.save,
    }
  }

  status(): HopperSignIn {
    return this.state
  }

  /** Register with the user's email, open Hopper's page with the code to confirm, and wait for the key in the background (R3.1). */
  async start(email: string): Promise<HopperSignIn> {
    const run = ++this.run
    this.state = { ...IDLE, inProgress: true }
    let reg: { claim_token?: unknown; claim?: { user_code?: unknown; verification_uri?: unknown; interval?: unknown; expires_in?: unknown } }
    try {
      const r = await this.d.fetch(REGISTER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Hopper-Client": "harness-for-rea" },
        body: JSON.stringify({ type: "service_auth", login_hint: email }),
      })
      reg = (await r.json().catch(() => ({}))) as typeof reg
      if (!r.ok)
        return this.fail(
          run,
          `Hopper refused the sign-in (${r.status}${typeof (reg as { error?: unknown }).error === "string" ? `: ${(reg as { error: string }).error}` : ""}).`,
        )
    } catch (e) {
      return this.fail(run, `Hopper could not be reached: ${(e as Error).message}`)
    }
    const url = String(reg.claim?.verification_uri ?? "")
    const code = String(reg.claim?.user_code ?? "")
    const token = String(reg.claim_token ?? "")
    if (!token || !code || !isHopperPage(url)) return this.fail(run, "Hopper answered the sign-in with no code or with a page outside withhopper.com.")
    if (run !== this.run) return this.state
    this.state = { ...this.state, code, url }
    await this.d.open(url).catch(() => false)
    const interval = Math.max(1, Number(reg.claim?.interval) || 5) * 1000
    const until = Date.now() + Math.max(60, Number(reg.claim?.expires_in) || 600) * 1000
    void this.poll(run, token, interval, until)
    return this.state
  }

  cancel(): HopperSignIn {
    if (this.state.inProgress) {
      this.run++
      this.state = { ...IDLE, error: "The sign-in was cancelled." }
    }
    return this.state
  }

  private fail(run: number, error: string): HopperSignIn {
    if (run === this.run) this.state = { ...IDLE, error }
    return this.state
  }

  /** Polls at Hopper's interval until the key comes, the code expires, or the sign-in is cancelled (R3.2, R3.3). */
  private async poll(run: number, claimToken: string, interval: number, until: number) {
    let delay = interval
    while (run === this.run) {
      await this.d.wait(delay)
      if (run !== this.run) return
      if (Date.now() > until) return void this.fail(run, "The code expired before it was confirmed. Sign in again.")
      delay = interval
      let r: Response
      let body: { access_token?: unknown; error?: unknown }
      try {
        r = await this.d.fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: claimToken }).toString(),
        })
        body = (await r.json().catch(() => ({}))) as typeof body
      } catch {
        continue
      }
      if (run !== this.run) return
      const error = typeof body.error === "string" ? body.error : ""
      if (r.ok) {
        const key = typeof body.access_token === "string" ? body.access_token : ""
        if (!key.startsWith("sk_hopper_")) return void this.fail(run, "Hopper answered with something that is not a Hopper key.")
        try {
          await this.d.save(key)
        } catch (e) {
          return void this.fail(run, (e as Error).message)
        }
        if (run === this.run) this.state = { ...IDLE, done: true }
        return
      }
      if (error === "authorization_pending" || r.status === 503) continue
      if (error === "slow_down" || r.status === 429) {
        delay = SLOW_DOWN_MS
        continue
      }
      if (error === "expired_token") return void this.fail(run, "The code expired before it was confirmed. Sign in again.")
      return void this.fail(run, `Hopper ended the sign-in${error ? ` (${error})` : ` (${r.status})`}. Sign in again.`)
    }
  }
}
