import { ORCHESTRATOR_EFFORTS, type OrchestratorEffort } from "./types"
/*
  The orchestrator's model providers (adr:0014-add-openai-compatible-orchestrator-providers). OpenRouter
  keeps its own client for its routing extras; every other provider speaks the OpenAI chat API, so it
  is a base URL, a key and a model name. Adding one is one entry here.
*/

export const PROVIDER_IDS = ["hopper", "openrouter", "deepseek", "river", "chatgpt", "custom"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const MODEL_PROTOCOLS = ["chat_completions", "responses"] as const
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** "openrouter" has a dedicated client; "openai" is any OpenAI-compatible chat endpoint */
  kind: "openrouter" | "openai"
  /** the endpoint a preset starts with; empty for a provider the user points at their own */
  baseUrl: string
  /** whether the user may change the base URL */
  editableBaseUrl: boolean
  /** whether the model list needs a key to be read */
  keyRequired: boolean
  defaultModel: string
  models: readonly string[]
  keyPlaceholder: string
  /** where an account and its key are made, offered beside the key; the app opens no other address for a provider */
  signupUrl?: string
  /** what the provider gives the app's users, said beside that link */
  offer?: string
  /** which model protocols this provider supports */
  supportedProtocols?: readonly ModelProtocol[]
  /** default protocol when none is selected */
  defaultProtocol?: ModelProtocol
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  // The default of both agents (specs/specialist-providers R1.4): an OpenAI-compatible endpoint serving a security model.
  hopper: {
    id: "hopper",
    label: "Hopper",
    kind: "openai",
    baseUrl: "https://api.withhopper.com/v1",
    editableBaseUrl: false,
    keyRequired: true,
    defaultModel: "deepseek-v4.1-flash-1017-abliterated",
    models: ["deepseek-v4.1-flash-1017-abliterated", "gemma-4-31b"],
    keyPlaceholder: "sk_hopper_…",
    signupUrl: "https://withhopper.com/cyber",
    // Requests carry Hopper's client header (attribution.ts), which is what the discount is applied by.
    offer: "20% off for Harness for REA users.",
    supportedProtocols: ["chat_completions"],
    defaultProtocol: "chat_completions",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    editableBaseUrl: false,
    keyRequired: false,
    defaultModel: "qwen/qwen3.8-flash",
    // Recommended first: the Qwen flash models, which did best in reverse-engineering and security work, then the
    // other Chinese models with tool calling and image input.
    models: [
      "qwen/qwen3.8-flash",
      "qwen/qwen3.7-flash",
      "deepseek/deepseek-v4.1-flash-1017",
      "z-ai/glm-5.3-flash",
      "moonshotai/kimi-k3.1-pro",
      "minimax/minimax-m3.1-flash",
    ],
    keyPlaceholder: "sk-or-v1-…",
    supportedProtocols: ["chat_completions"],
    defaultProtocol: "chat_completions",
  },
  river: {
    id: "river",
    label: "River",
    kind: "openai",
    baseUrl: "https://api.river.ai/v1",
    editableBaseUrl: false,
    keyRequired: true,
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    models: [
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "GLM-5.3",
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      "zai-org/GLM-5.3-Flash",
      "Qwen/Qwen3.8-27B-FP8",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "moonshotai/Kimi-K3",
    ],
    keyPlaceholder: "rv-…",
    signupUrl: "https://console.river.ai/keys",
    offer: "API key from the River Console.",
    supportedProtocols: ["chat_completions", "responses"],
    defaultProtocol: "chat_completions",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    editableBaseUrl: true,
    keyRequired: true,
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat"],
    keyPlaceholder: "sk-…",
    supportedProtocols: ["chat_completions"],
    defaultProtocol: "chat_completions",
  },
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT (Codex)",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    editableBaseUrl: false,
    keyRequired: true,
    defaultModel: "",
    models: [],
    keyPlaceholder: "OAuth session token",
    signupUrl: "https://chatgpt.com",
    offer: "Use your ChatGPT Plus or Pro plan via OpenAI token sharing.",
    supportedProtocols: ["responses"],
    defaultProtocol: "responses",
  },
  custom: {
    id: "custom",
    label: "OpenAI-compatible",
    kind: "openai",
    baseUrl: "",
    editableBaseUrl: true,
    keyRequired: false,
    defaultModel: "",
    models: [],
    keyPlaceholder: "API key",
    supportedProtocols: ["chat_completions", "responses"],
    defaultProtocol: "chat_completions",
  },
}

/**
  Who the specialist runs on (adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent): `claude` is Claude
  Code on the user's plan; any other is a DeepAgents agent on that orchestrator provider's model, with its key and base URL.
*/
export const SPECIALIST_PROVIDERS = ["claude", ...PROVIDER_IDS] as const
export type SpecialistProvider = (typeof SPECIALIST_PROVIDERS)[number]

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v)
}

/** Strips trailing slashes and known endpoints (/chat/completions, /completions, /models, /responses). */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models|responses)$/, "")
}

/** The base URL a run uses: the user's for an editable provider, else the preset's. */
export function resolveBaseUrl(provider: ProviderId, baseUrl: string): string {
  const p = PROVIDERS[provider]
  const raw = p.editableBaseUrl && baseUrl.trim() ? baseUrl.trim() : p.baseUrl
  return normalizeBaseUrl(raw)
}

/**
  Builds the full URL for a provider endpoint without duplicating path segments like /v1 or endpoints.
*/
export function resolveEndpointUrl(base: string, endpoint: "responses" | "chat/completions" | "models"): string {
  const clean = normalizeBaseUrl(base)
  if (endpoint === "responses") {
    return /\/v\d+$/.test(clean) ? `${clean}/responses` : `${clean}/v1/responses`
  }
  if (endpoint === "chat/completions") {
    return `${clean}/chat/completions`
  }
  return `${clean}/${endpoint}`
}

/** The vendors of Chinese models on OpenRouter, whose coding models the model choice lists next. */
export const CHINESE_VENDORS = [
  "deepseek",
  "z-ai",
  "qwen",
  "moonshotai",
  "minimax",
  "thudm",
  "baidu",
  "tencent",
  "bytedance-seed",
  "bytedance",
  "stepfun",
  "meituan",
  "inclusionai",
  "xiaomi",
]

export interface ModelGroup {
  label: string
  models: string[]
}

/**
  A provider's models as the model choice offers them: its recommended ones first, then, for OpenRouter, the Chinese
  models it lists with tool calling — coding models first — then every other model it lists. Batch variants are left
  out: a task needs answers now.
*/
export function groupModels(provider: ProviderId, listed: string[]): ModelGroup[] {
  if (provider === "chatgpt") {
    const unique = [...new Set(listed)]
    return unique.length ? [{ label: "Models", models: unique }] : []
  }
  if (provider === "river") {
    if (listed.length > 0) {
      const presets = PROVIDERS.river.models
      const availablePresets = presets.filter((m) => listed.includes(m))
      const extra = [...new Set(listed)].filter((m) => !presets.includes(m) && !m.endsWith(":batch")).sort()
      return [
        { label: "Recommended", models: availablePresets },
        { label: "Models", models: extra },
      ].filter((g) => g.models.length)
    }
    return [{ label: "Recommended", models: [...PROVIDERS.river.models] }]
  }
  const recommended = [...PROVIDERS[provider].models]
  const rest = [...new Set(listed)].filter((m) => !recommended.includes(m) && !m.endsWith(":batch"))
  if (provider !== "openrouter")
    return [
      { label: "Recommended", models: recommended },
      { label: "Models", models: rest.sort() },
    ].filter((g) => g.models.length)
  const vendor = (m: string) => m.split("/")[0]
  const coding = (m: string) => /cod(e|er|ing)/i.test(m)
  const chinese = rest.filter((m) => CHINESE_VENDORS.includes(vendor(m))).sort((a, b) => Number(coding(b)) - Number(coding(a)) || a.localeCompare(b))
  const others = rest.filter((m) => !CHINESE_VENDORS.includes(vendor(m))).sort()
  return [
    { label: "Recommended", models: recommended },
    { label: "Chinese coding models", models: chinese },
    { label: "Other models with tool calling", models: others },
  ].filter((g) => g.models.length)
}

export type ReasoningEffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface ModelReasoningProfile {
  supportedEfforts: readonly ("none" | "low" | "medium" | "high" | "xhigh" | "max")[]
  defaultEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"
  mandatoryReasoning: boolean
}

export const RIVER_MODEL_REASONING: Record<string, ModelReasoningProfile> = {
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
    supportedEfforts: ["none", "low", "high", "max"],
    defaultEffort: "none",
    mandatoryReasoning: false,
  },
  "deepseek-ai/DeepSeek-V4.1-Flash": {
    supportedEfforts: ["none", "low", "high", "max"],
    defaultEffort: "none",
    mandatoryReasoning: false,
  },
  "moonshotai/Kimi-K3": {
    supportedEfforts: ["none", "low", "high", "max"],
    defaultEffort: "max",
    mandatoryReasoning: false,
  },
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": {
    supportedEfforts: ["none", "medium", "high"],
    defaultEffort: "high",
    mandatoryReasoning: false,
  },
  "GLM-5.3": {
    supportedEfforts: ["low", "high", "max"],
    defaultEffort: "max",
    mandatoryReasoning: true,
  },
  "zai-org/GLM-5.3-Flash": {
    supportedEfforts: ["low", "high", "max"],
    defaultEffort: "max",
    mandatoryReasoning: true,
  },
  "Qwen/Qwen3.8-27B-FP8": {
    supportedEfforts: ["none", "low", "medium", "xhigh"],
    defaultEffort: "xhigh",
    mandatoryReasoning: false,
  },
}

export function getRiverModelReasoning(model: string): ModelReasoningProfile | undefined {
  if (!model) return undefined
  if (RIVER_MODEL_REASONING[model]) return RIVER_MODEL_REASONING[model]
  const lower = model.toLowerCase().trim()
  for (const [key, profile] of Object.entries(RIVER_MODEL_REASONING)) {
    if (key.toLowerCase() === lower) return profile
    const keyWithoutOrg = key.includes("/") ? key.split("/")[1]!.toLowerCase() : key.toLowerCase()
    if (keyWithoutOrg === lower) return profile
  }
  return undefined
}

export function getAvailableEffortsForModel(provider: ProviderId, model: string): readonly OrchestratorEffort[] {
  if (provider === "river") {
    const profile = getRiverModelReasoning(model)
    if (profile) {
      return ["default", ...profile.supportedEfforts]
    }
  }
  return ORCHESTRATOR_EFFORTS
}

export function validateReasoningEffort(provider: ProviderId, model: string, effort: string | undefined): void {
  if (!effort || effort === "default") return
  if (provider === "river") {
    const profile = getRiverModelReasoning(model)
    if (profile) {
      if (!profile.supportedEfforts.includes(effort as any)) {
        throw new Error(`Model "${model}" on River does not support reasoning effort "${effort}". Supported efforts: ${profile.supportedEfforts.join(", ")}.`)
      }
    }
  }
}
