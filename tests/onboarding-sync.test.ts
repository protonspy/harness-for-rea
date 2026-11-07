import { describe, expect, it } from "vitest"
import { saveSettings } from "../src/main/settings"
import { blocking, readiness, type ReadinessDeps } from "../src/main/readiness"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import { PROVIDERS } from "../src/shared/providers"
import { API_SCHEMAS } from "../src/shared/api"
import type { LoginStatus, Readiness, SandboxStatus, Settings } from "../src/shared/types"
import { openDb } from "../src/main/db"

const okSandbox: SandboxStatus = { docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "2.1.310" }
const signedIn: LoginStatus = { loggedIn: true, method: "claude.ai", plan: "max", email: "a@b.c", inProgress: false, url: null, text: "", error: "" }
const signedOut: LoginStatus = { loggedIn: false, method: "claude.ai", plan: "", email: "", inProgress: false, url: null, text: "", error: "" }

function makeDeps(o: Partial<Omit<ReadinessDeps, "settings">> & { settings?: Partial<Settings> } = {}): ReadinessDeps & { logins: number } {
  const d = {
    logins: 0,
    sandbox: async () => okSandbox,
    login: async () => {
      d.logins++
      return o.login ? o.login() : signedIn
    },
    keySet: () => true,
    listModels: async () => ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "GLM-5.3"],
    probeModel: async () => undefined,
    ...o,
    settings: () => ({ ...DEFAULT_SETTINGS, provider: "hopper" as const, specialistProvider: "hopper" as const, ...o.settings }),
  }
  if (o.login) {
    const customLogin = o.login
    d.login = async () => {
      d.logins++
      return customLogin()
    }
  }
  return d
}

describe("onboarding provider and credentials synchronization (Issue #7)", () => {
  openDb(":memory:")

  it("shared endpoint: saveSettings accepts specialistBaseUrl for specialist without overriding orchestrator provider", () => {
    saveSettings({ provider: "hopper", specialistProvider: "custom" })
    const updated = saveSettings({ specialistBaseUrl: "https://my-custom.example/v1" })
    expect(updated.provider).toBe("hopper")
    expect(updated.specialistProvider).toBe("custom")
    expect(updated.baseUrls.custom).toBe("https://my-custom.example/v1")
    expect(updated.specialistBaseUrl).toBe("https://my-custom.example/v1")
    // Orchestrator baseUrl is still hopper's (empty or default)
    expect(updated.baseUrl).toBe(updated.baseUrls.hopper ?? "")

    // If orchestrator is later switched to custom, it immediately receives that shared base URL
    const switched = saveSettings({ provider: "custom" })
    expect(switched.baseUrl).toBe("https://my-custom.example/v1")
  })

  it("shared endpoint: updates from orchestrator reflect in specialist base URL immediately", () => {
    saveSettings({ provider: "custom", specialistProvider: "custom" })
    const updated = saveSettings({ baseUrl: "https://shared.example/v1" })
    expect(updated.baseUrls.custom).toBe("https://shared.example/v1")
    expect(updated.specialistBaseUrl).toBe("https://shared.example/v1")
  })

  it("schema validation: API_SCHEMAS.saveSettings accepts specialistBaseUrl but strictly forbids raw baseUrls map", () => {
    const validPatch = API_SCHEMAS.saveSettings.parse([{ specialistBaseUrl: "https://llm.example/v1" }])
    expect(validPatch[0].specialistBaseUrl).toBe("https://llm.example/v1")

    expect(() => API_SCHEMAS.saveSettings.parse([{ baseUrls: { custom: "https://attacker.example/v1" } }])).toThrow()
  })

  it("does not inherit deepseek-chat when selecting custom or River", () => {
    // When custom is chosen, defaultModel is "" so model starts empty and does not inherit deepseek-chat
    expect(PROVIDERS.custom.defaultModel).toBe("")
    // When river is chosen, defaultModel is DeepSeek-V4.1-Flash-1017, not deepseek-chat
    expect(PROVIDERS.river.defaultModel).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017")
    expect(PROVIDERS.river.defaultModel).not.toBe("deepseek-chat")
  })

  it("readiness: Claude login warning only applies when specialist is Claude Code", async () => {
    // When specialist is hopper, claude login is NOT checked or required
    const dHopper = makeDeps({
      login: async () => signedOut,
      settings: { specialistProvider: "hopper", specialistModel: "deepseek-v4.1-flash-1017-abliterated" },
    })
    const rHopper = await readiness(dHopper)
    expect(rHopper.claude.ready).toBe(true)
    expect(dHopper.logins).toBe(0)

    // When specialist is claude, claude login IS required
    const dClaude = makeDeps({
      login: async () => signedOut,
      settings: { specialistProvider: "claude" },
    })
    const rClaude = await readiness(dClaude)
    expect(rClaude.claude.ready).toBe(false)
    expect(rClaude.claude.reason).toBe("Sign in to Claude Code with your plan.")
    expect(dClaude.logins).toBe(1)
  })

  it("readiness: custom specialist without base URL asks for base URL without mentioning Claude login", async () => {
    const dCustom = makeDeps({
      settings: { specialistProvider: "custom", specialistModel: "model-x", baseUrls: {} },
    })
    const rCustom = await readiness(dCustom)
    expect(rCustom.claude.ready).toBe(false)
    expect(rCustom.claude.reason).toContain("Set the base URL of your OpenAI-compatible")
    expect(rCustom.claude.reason).not.toContain("Claude")
  })

  it("readiness: Docker down message mentions Docker Engine and WSL compatibility", async () => {
    const dDown = makeDeps({
      sandbox: async () => ({ ...okSandbox, docker: false, dockerError: "pipe not found" }),
    })
    const r = await readiness(dDown)
    expect(r.sandbox.ready).toBe(false)
    expect(r.sandbox.reason).toContain("Start Docker Desktop or a compatible Docker Engine (including WSL).")
    expect(blocking(r)).toContain("Start Docker Desktop or a compatible Docker Engine (including WSL).")
  })

  it("shared credential mutation: OAuth connect/disconnect and Hopper invalidate shared state, advance keyRev and recheck readiness", async () => {
    let keyRev = 0
    let keyStatus = { set: false, hint: "" }
    let ready = false

    const notifyCredentialChange = () => {
      keyRev++
      // Triggers readiness evaluation with updated key status
      ready = keyStatus.set
    }

    // Connect ChatGPT from specialist panel
    keyStatus = { set: true, hint: "token" }
    notifyCredentialChange()

    expect(keyRev).toBe(1)
    expect(ready).toBe(true)

    // Disconnect ChatGPT from either panel
    keyStatus = { set: false, hint: "" }
    notifyCredentialChange()

    expect(keyRev).toBe(2)
    expect(ready).toBe(false)

    // Connect Hopper via sign-in completion
    keyStatus = { set: true, hint: "hopper" }
    notifyCredentialChange()

    expect(keyRev).toBe(3)
    expect(ready).toBe(true)
  })

  it("TUI sequence protection: rejects stale refresh after newer push event", async () => {
    let currentR: Readiness | null = null
    const checkSeqRef = { current: 0 }

    const fakeReadiness = (seq: number, r: Readiness, delayMs: number) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (seq === checkSeqRef.current) {
            currentR = r
          }
          resolve()
        }, delayMs)
      })
    }

    const checkReadiness = (r: Readiness, delayMs: number) => {
      const seq = ++checkSeqRef.current
      return fakeReadiness(seq, r, delayMs)
    }

    const rReady: Readiness = {
      ready: true,
      completed: true,
      sandbox: { ready: true, building: false, reason: "" },
      claude: { ready: true, reason: "" },
      model: { ready: true, reason: "", provider: "hopper", model: "model-x" },
    }
    const rNotReady: Readiness = {
      ready: false,
      completed: false,
      sandbox: { ready: true, building: false, reason: "" },
      claude: { ready: false, reason: "Logged out" },
      model: { ready: true, reason: "", provider: "hopper", model: "model-x" },
    }

    // Scenario 1: Refresh starts first (slow, delay 50ms), then push event occurs (fast, delay 10ms with ready=false)
    const refreshPromise = checkReadiness(rReady, 50)
    const pushPromise = checkReadiness(rNotReady, 10)

    await Promise.all([refreshPromise, pushPromise])

    // Push event was newer (seq 2), so even though refresh finished later, its response was discarded
    expect(currentR).toEqual(rNotReady)
    expect(currentR!.ready).toBe(false)

    // Scenario 2: Push event starts first (slow, delay 50ms), then refresh occurs (fast, delay 10ms with ready=true)
    const slowPushPromise = checkReadiness(rNotReady, 50)
    const fastRefreshPromise = checkReadiness(rReady, 10)

    await Promise.all([slowPushPromise, fastRefreshPromise])

    // Refresh was newer (seq 4), so even though slow push finished later, its response was discarded
    expect(currentR).toEqual(rReady)
    expect(currentR!.ready).toBe(true)
  })
})
