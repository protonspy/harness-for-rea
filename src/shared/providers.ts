/*
  The orchestrator's model providers (adr:0014-add-openai-compatible-orchestrator-providers). OpenRouter
  keeps its own client for its routing extras; every other provider speaks the OpenAI chat API, so it
  is a base URL, a key and a model name. Adding one is one entry here.
*/

export const PROVIDER_IDS = ["openrouter", "deepseek", "custom"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

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
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    editableBaseUrl: false,
    keyRequired: false,
    defaultModel: "deepseek/deepseek-v4.1-flash-1017",
    models: ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash"],
    keyPlaceholder: "sk-or-v1-…",
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
  },
}

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v)
}

/** The base URL a run uses: the user's for an editable provider, else the preset's. */
export function resolveBaseUrl(provider: ProviderId, baseUrl: string): string {
  const p = PROVIDERS[provider]
  return (p.editableBaseUrl && baseUrl.trim() ? baseUrl.trim() : p.baseUrl).replace(/\/+$/, "")
}
