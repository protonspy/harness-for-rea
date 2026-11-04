import { describe, expect, it } from "vitest"
import { CLAIM_GRANT, hopperPage, HopperSignInService, isHopperPage, REGISTER_URL, SLOW_DOWN_MS, TOKEN_URL, type Fetch } from "../src/main/hopper"

/* Signing in to Hopper through its agent registration (specs/specialist-providers R3). */

type Answer = { status: number; body: object }
const REGISTERED: Answer = {
  status: 200,
  body: {
    registration_id: "reg_1",
    claim_token: "clm_1",
    claim: { user_code: "123456", expires_in: 600, verification_uri: "https://withhopper.com/claim?claim_attempt_token=cla_1", interval: 5 },
  },
}
const pending: Answer = { status: 400, body: { error: "authorization_pending" } }

function harness(answers: Answer[]) {
  const requests: { url: string; init: RequestInit }[] = []
  const opened: string[] = []
  const saved: string[] = []
  const waits: number[] = []
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, init })
    const a = answers.shift() ?? pending
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } })
  }
  let release: () => void = () => undefined
  const idle = new Promise<void>((r) => (release = r))
  const s = new HopperSignInService({
    fetch,
    open: async (url) => opened.push(url) > 0,
    save: async (key) => void saved.push(key),
    wait: async (ms) => {
      waits.push(ms)
      if (waits.length > 20) await idle
    },
  })
  const settled = async () => {
    for (let i = 0; i < 50 && s.status().inProgress; i++) await new Promise((r) => setTimeout(r, 1))
  }
  return { s, requests, opened, saved, waits, settled, release }
}

describe("the Hopper sign-in", () => {
  it("registers with the email, opens Hopper's page with the code, and keeps the key it hands back (R3.1, R3.2)", async () => {
    const h = harness([REGISTERED, pending, { status: 200, body: { access_token: "sk_hopper_abc", token_type: "Bearer", scope: "api" } }])
    const started = await h.s.start("me@example.com")
    expect(started).toMatchObject({ inProgress: true, code: "123456", url: "https://withhopper.com/claim?claim_attempt_token=cla_1" })
    expect(h.requests[0].url).toBe(REGISTER_URL)
    expect(JSON.parse(String(h.requests[0].init.body))).toEqual({ type: "service_auth", login_hint: "me@example.com" })
    expect(h.opened).toEqual(["https://withhopper.com/claim?claim_attempt_token=cla_1"])
    await h.settled()
    expect(h.s.status()).toMatchObject({ inProgress: false, done: true, error: "" })
    expect(h.saved).toEqual(["sk_hopper_abc"])
    // polled at Hopper's interval, with the claim grant
    expect(h.waits).toEqual([5000, 5000])
    expect(h.requests[1].url).toBe(TOKEN_URL)
    expect(Object.fromEntries(new URLSearchParams(String(h.requests[1].init.body)))).toEqual({ grant_type: CLAIM_GRANT, claim_token: "clm_1" })
  })

  it("waits a minute when Hopper says to slow down", async () => {
    const h = harness([REGISTERED, { status: 429, body: { error: "slow_down" } }, { status: 200, body: { access_token: "sk_hopper_x" } }])
    await h.s.start("me@example.com")
    await h.settled()
    expect(h.waits).toEqual([5000, SLOW_DOWN_MS])
  })

  it("stops and stores nothing when the code expires, Hopper ends it, or the user cancels (R3.3)", async () => {
    const expired = harness([REGISTERED, { status: 400, body: { error: "expired_token" } }])
    await expired.s.start("me@example.com")
    await expired.settled()
    expect(expired.s.status()).toMatchObject({ inProgress: false, done: false, error: expect.stringMatching(/expired/) })
    expect(expired.saved).toEqual([])

    const refused = harness([{ status: 400, body: { error: "invalid_login_hint" } }])
    expect(await refused.s.start("x@example.com")).toMatchObject({
      inProgress: false,
      error: expect.stringMatching(/refused the sign-in \(400: invalid_login_hint\)/),
    })

    const cancelled = harness([REGISTERED])
    await cancelled.s.start("me@example.com")
    expect(cancelled.s.cancel()).toMatchObject({ inProgress: false, error: "The sign-in was cancelled." })
    cancelled.release()
    await new Promise((r) => setTimeout(r, 5))
    expect(cancelled.saved).toEqual([])
  })

  it("opens no page outside withhopper.com and keeps nothing that is not a Hopper key (R3.4)", async () => {
    const elsewhere = harness([{ status: 200, body: { ...REGISTERED.body, claim: { user_code: "1", verification_uri: "https://evil.example/claim" } } }])
    expect(await elsewhere.s.start("me@example.com")).toMatchObject({ inProgress: false, error: expect.stringMatching(/outside withhopper.com/) })
    expect(elsewhere.opened).toEqual([])
    const odd = harness([REGISTERED, { status: 200, body: { access_token: "not-a-key" } }])
    await odd.s.start("me@example.com")
    await odd.settled()
    expect(odd.saved).toEqual([])
    expect(isHopperPage("https://withhopper.com/claim")).toBe(true)
    // what is opened is the address as it was checked
    expect(hopperPage("https://withhopper.com\\claim?x=1")).toBe("https://withhopper.com/claim?x=1")
    expect(hopperPage("https://with\thopper.com/claim")).toBe("https://withhopper.com/claim")
    for (const u of ["http://withhopper.com/claim", "https://withhopper.com.evil.example/", "https://u:p@withhopper.com/", "nope"])
      expect(isHopperPage(u)).toBe(false)
  })
})
