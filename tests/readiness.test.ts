import { describe, expect, it } from "vitest"
import { DEFAULT_MODEL, DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { LoginStatus, SandboxStatus, Settings } from "../src/shared/types"
import { blocking, needsKey, readiness, type ReadinessDeps } from "../src/main/readiness"
import { groupModels, PROVIDERS } from "../src/shared/providers"

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
    probeModel: async () => undefined,
    ...o,
    // OpenRouter and the Claude plan, the steps these tests were written for.
    settings: () => ({ ...DEFAULT_SETTINGS, provider: "openrouter" as const, model: DEFAULT_MODEL, specialistProvider: "claude" as const, ...o.settings }),
  }
  return d
}

describe("the specialist on a provider (specs/specialist-providers R1.3)", () => {
  const onHopper = { specialistProvider: "hopper" as const, specialistModel: "deepseek-v4.1-flash-1017-abliterated" }

  it("is ready with the provider's key and a model, without reading the Claude sign-in", async () => {
    const d = deps({ settings: onHopper })
    const r = await readiness(d)
    expect(r.claude).toMatchObject({ ready: true, provider: "hopper", model: onHopper.specialistModel })
    expect(d.logins).toBe(0)
  })

  it("asks for that provider's key, its base URL and the specialist's model", async () => {
    const keys = (p: string) => p !== "hopper"
    expect((await readiness(deps({ settings: onHopper, keySet: keys }))).claude.reason).toBe("Set your Hopper API key: the specialist runs on it.")
    expect((await readiness(deps({ settings: { ...onHopper, specialistModel: " " } }))).claude.reason).toBe("Choose the specialist's model on Hopper.")
    const custom = { specialistProvider: "custom" as const, specialistModel: "m", baseUrls: {} }
    expect((await readiness(deps({ settings: custom }))).claude.reason).toMatch(/^Set the base URL of your OpenAI-compatible/)
    // A local server takes no key.
    expect((await readiness(deps({ settings: { ...custom, baseUrls: { custom: "http://localhost:8000/v1" } }, keySet: () => false }))).claude.ready).toBe(true)
  })
})

describe("a provider with no model list (specs/onboarding R1.6)", () => {
  const custom = { provider: "custom" as const, baseUrl: "https://llm.example/v1", model: "my-model" }
  const noList = async () => Promise.reject(new Error("OpenAI-compatible answered 404 to the model list."))
  const refused = Object.assign(new Error("OpenAI-compatible rejected the API key. Set a valid key in Settings."), { status: 401 })

  it("is ready when a one-token test request to the chosen model answers", async () => {
    let tried = 0
    const r = await readiness(
      deps({
        settings: custom,
        listModels: noList,
        probeModel: async (run) => void (tried++, expect(run).toMatchObject({ model: "my-model", baseUrl: "https://llm.example/v1" })),
      }),
    )
    expect(r.model).toMatchObject({ ready: true })
    expect(tried).toBe(1)
  })

  it("does not spend a second test request on the same provider, endpoint, model and key", async () => {
    let tried = 0
    const d = deps({ settings: { ...custom, model: "cached-model" }, listModels: noList, probeModel: async () => void tried++, keyHint: () => "…abcd" })
    await readiness(d)
    await readiness(d)
    expect(tried).toBe(1)
    await readiness(deps({ settings: { ...custom, model: "cached-model" }, listModels: noList, probeModel: async () => void tried++, keyHint: () => "…wxyz" }))
    expect(tried).toBe(2)
  })

  it("says why when the test request fails, and that a refused key is refused, test or no test", async () => {
    const failed = await readiness(
      deps({
        settings: { ...custom, model: "missing" },
        listModels: noList,
        probeModel: async () => Promise.reject(new Error("answered 404 to a test request to missing.")),
      }),
    )
    expect(failed.model).toMatchObject({ ready: false, reason: expect.stringMatching(/has no model list, and a test request failed: answered 404/) })
    let tried = 0
    const listRefused = await readiness(
      deps({ settings: { ...custom, model: "other" }, listModels: async () => Promise.reject(refused), probeModel: async () => void tried++ }),
    )
    expect(listRefused.model).toMatchObject({ ready: false, reason: refused.message })
    expect(tried).toBe(0)
    const probeRefused = await readiness(deps({ settings: { ...custom, model: "third" }, listModels: noList, probeModel: async () => Promise.reject(refused) }))
    expect(probeRefused.model.reason).toBe(refused.message)
  })
})

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
    expect(r.sandbox).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/Docker is not running \(pipe not found\)\. Start Docker Desktop or a compatible Docker Engine/),
    })
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
    expect((await readiness(deps({ listModels: async () => [] }))).model.reason).toMatch(/listed no models/)
    // a local OpenAI-compatible endpoint may take no key
    expect(needsKey("custom")).toBe(false)
    const local = { provider: "custom" as const, model: "local", baseUrl: "http://localhost:1234/v1" }
    expect((await readiness(deps({ keySet: () => false, settings: local }))).model.ready).toBe(true)
    // a custom endpoint with no base URL would send the key to the client library's default endpoint
    expect((await readiness(deps({ keySet: () => false, settings: { provider: "custom", model: "local" } }))).model.reason).toMatch(/Set the base URL/)
  })

  it("checks a project's own provider and model, and a task start lists no models (R2.1)", async () => {
    const seen: string[] = []
    const d = deps({ keySet: (p) => p === "openrouter", listModels: async (run) => (seen.push(run.provider), ["x"]) })
    const deepseek = await readiness(d, { run: { provider: "deepseek", model: "deepseek-chat" } })
    expect(deepseek.model).toMatchObject({ ready: false, provider: "deepseek", reason: "Set your DeepSeek API key." })
    const own = await readiness(d, { run: { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, list: false })
    expect(own.model).toMatchObject({ ready: true, model: "z-ai/glm-5.3-flash" })
    expect(seen).toEqual([])
    // a project on a custom endpoint while Settings is on another provider has no base URL to use
    const custom = await readiness(deps(), { run: { provider: "custom", model: "local" }, list: false })
    expect(custom.model.reason).toMatch(/Set the base URL/)
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

describe("the orchestrator's model choice (specs/onboarding R1.5)", () => {
  it("offers OpenRouter's recommended models first, Qwen's flash models by default, then Chinese coding models, then the rest (specs/orchestrator R1.1)", () => {
    expect(PROVIDERS.openrouter.defaultModel).toBe("qwen/qwen3.8-flash")
    expect(PROVIDERS.openrouter.models.slice(0, 2)).toEqual(["qwen/qwen3.8-flash", "qwen/qwen3.7-flash"])
    expect(PROVIDERS.openrouter.models).toContain("z-ai/glm-5.3-flash")
    const groups = groupModels("openrouter", [
      "openai/gpt-6",
      "qwen/qwen3.8-flash",
      "moonshotai/kimi-k2.7-code",
      "bytedance-seed/seed-2.0-code",
      "z-ai/glm-5.3:batch",
      "anthropic/claude-x",
      "tencent/hy3",
    ])
    expect(groups.map((g) => g.label)).toEqual(["Recommended", "Chinese coding models", "Other models with tool calling"])
    expect(groups[0].models).toEqual(PROVIDERS.openrouter.models)
    // coding models lead the Chinese ones; a recommended model is not listed twice; batch variants are left out
    expect(groups[1].models).toEqual(["bytedance-seed/seed-2.0-code", "moonshotai/kimi-k2.7-code", "tencent/hy3"])
    expect(groups[2].models).toEqual(["anthropic/claude-x", "openai/gpt-6"])
  })

  it("lists another provider's models after its recommended ones", () => {
    expect(groupModels("deepseek", ["deepseek-chat", "deepseek-reasoner"])).toEqual([
      { label: "Recommended", models: ["deepseek-chat"] },
      { label: "Models", models: ["deepseek-reasoner"] },
    ])
    expect(groupModels("custom", [])).toEqual([])
  })
})
