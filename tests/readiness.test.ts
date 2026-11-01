import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { LoginStatus, SandboxStatus, Settings } from "../src/shared/types"
import { blocking, needsKey, readiness, type ReadinessDeps } from "../src/main/readiness"

/* specs/onboarding R1.3–R1.8, R2.1: the three steps of the first-run setup. */

const okSandbox: SandboxStatus = { docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "2.1.310" }
const signedIn: LoginStatus = { loggedIn: true, method: "claude.ai", plan: "max", email: "a@b.c", inProgress: false, url: null, text: "", error: "" }

function deps(o: Partial<Omit<ReadinessDeps, "settings">> & { settings?: Partial<Settings> } = {}): ReadinessDeps & { logins: number } {
  const d = {
    logins: 0,
    sandbox: async () => okSandbox,
    login: async () => {
      d.logins++
      return signedIn
    },
    keySet: () => true,
    listModels: async () => ["deepseek/deepseek-v4.1-flash-1017"],
    ...o,
    settings: () => ({ ...DEFAULT_SETTINGS, ...o.settings }),
  }
  return d
}

describe("the setup's steps", () => {
  it("is ready when the sandbox, Claude Code and the model all are", async () => {
    const r = await readiness(deps())
    expect(r).toMatchObject({ ready: true, completed: false })
    expect(r.claude).toMatchObject({ ready: true, plan: "max" })
    expect(r.model).toMatchObject({ ready: true, provider: "openrouter" })
    expect(blocking(r)).toBeNull()
  })

  it("says why the sandbox is not ready, and waits for it before reading the sign-in (R1.3, R1.7)", async () => {
    const down = deps({ sandbox: async () => ({ ...okSandbox, docker: false, dockerError: "pipe not found" }) })
    const r = await readiness(down)
    expect(r.sandbox).toMatchObject({ ready: false, reason: expect.stringMatching(/Docker is not running \(pipe not found\)\. Start Docker Desktop/) })
    expect(r.claude).toMatchObject({ ready: false, reason: expect.stringMatching(/Ready the sandbox first/) })
    expect(down.logins).toBe(0)
    expect((await readiness(deps({ sandbox: async () => ({ ...okSandbox, images: false }) }))).sandbox.reason).toMatch(/not prepared yet\. Prepare them/)
    expect((await readiness(deps({ sandbox: async () => ({ ...okSandbox, building: true }) }))).sandbox).toMatchObject({ ready: false, building: true })
  })

  it("asks to sign in Claude Code, and reports a sign-in that cannot be read (R1.4, R1.7)", async () => {
    const out = await readiness(deps({ login: async () => ({ ...signedIn, loggedIn: false }) }))
    expect(out.claude).toMatchObject({ ready: false, reason: "Sign in to Claude Code with your plan." })
    const broken = await readiness(deps({ login: async () => Promise.reject(new Error("volume busy")) }))
    expect(broken.claude.reason).toMatch(/could not be read: volume busy/)
  })

  it("asks for the provider's key, a model, and an answer from the provider (R1.6, R1.7)", async () => {
    expect((await readiness(deps({ keySet: () => false }))).model.reason).toBe("Set your OpenRouter API key.")
    expect((await readiness(deps({ settings: { model: " " } }))).model.reason).toBe("Choose a model from OpenRouter.")
    expect((await readiness(deps({ listModels: async () => Promise.reject(new Error("401")) }))).model.reason).toMatch(/OpenRouter did not answer: 401/)
    expect((await readiness(deps({ listModels: async () => [] }))).model.reason).toMatch(/listed no models/)
    // a local OpenAI-compatible endpoint may take no key
    expect(needsKey("custom")).toBe(false)
    expect((await readiness(deps({ keySet: () => false, settings: { provider: "custom", model: "local" } }))).model.ready).toBe(true)
  })

  it("names the first step that blocks a task (R2.1)", async () => {
    const r = await readiness(deps({ keySet: () => false }))
    expect(r.ready).toBe(false)
    expect(blocking(r)).toBe("Set your OpenRouter API key.")
  })

  it("reports a setup the user completed", async () => {
    expect((await readiness(deps({ settings: { setupCompleted: true } }))).completed).toBe(true)
  })
})
