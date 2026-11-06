import { attributionHeaders } from "./attribution"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { ChatOpenRouter } from "@langchain/openrouter"
import { PRESET_MODEL } from "@shared/defaults"
import { PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import type { OrchestratorEffort } from "@shared/types"
import { resolveChatGPTAccessToken, type ChatGPTAuthService } from "../chatgpt"

/*
  The orchestrator's chat model (specs/orchestrator R1, adr:0014-add-openai-compatible-orchestrator-providers).
  On OpenRouter: any model the user picked, with the preset as the fallback in OpenRouter's `models`
  routing and provider data collection denied since source code is sent. On any other provider: the
  OpenAI chat API at the provider's base URL, DeepSeek's being one preset. Each call's usage and cost
  is handed to `onUsage`.
*/

let globalChatGPTService: ChatGPTAuthService | undefined

export function setChatGPTAuthService(service: ChatGPTAuthService | undefined): void {
  globalChatGPTService = service
}

export function getChatGPTAuthService(): ChatGPTAuthService | undefined {
  return globalChatGPTService
}

export interface ModelUsage {
  tokensIn: number
  tokensOut: number
  /** OpenRouter's `usage.cost`, in USD; 0 when the provider did not report one (OpenAI-compatible APIs do not) */
  costUsd: number
  /** the model that actually answered, which differs from the chosen one after a fallback */
  model: string
}

export function fallbackModels(model: string): string[] {
  return model === PRESET_MODEL ? [model] : [model, PRESET_MODEL]
}

interface LlmEndOutput {
  llmOutput?: { tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }
  generations?: { message?: { response_metadata?: { model_name?: string }; usage_metadata?: { input_tokens?: number; output_tokens?: number } } }[][]
}

/** One completed call's usage, from OpenRouter's `usage` object as LangChain passes it on. */
export function usageOf(output: LlmEndOutput, fallback: string): ModelUsage {
  const raw = output.llmOutput?.tokenUsage
  const msg = output.generations?.[0]?.[0]?.message
  return {
    tokensIn: raw?.prompt_tokens ?? msg?.usage_metadata?.input_tokens ?? 0,
    tokensOut: raw?.completion_tokens ?? msg?.usage_metadata?.output_tokens ?? 0,
    costUsd: typeof raw?.cost === "number" ? raw.cost : 0,
    model: msg?.response_metadata?.model_name ?? fallback,
  }
}

export interface ModelOptions {
  provider: ProviderId
  /** the endpoint of an OpenAI-compatible provider; OpenRouter ignores it */
  baseUrl?: string
  apiKey: string
  model: string
  effort?: OrchestratorEffort
  onUsage(u: ModelUsage): void
}

export function resolveApiKey(provider: ProviderId, apiKey: string): string {
  if (provider === "chatgpt" && apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { accessToken?: string }
      return parsed.accessToken ?? apiKey
    } catch {
      return apiKey
    }
  }
  return apiKey
}

/**
 * Creates a ChatGPT model client speaking the official Responses API protocol
 * with native SDK Responses support (`useResponsesApi: true`, `streaming: true`, `store: false`) (C2, C3).
 */
function createChatGPTResponsesModel(o: ModelOptions): BaseChatModel {
  const callbacks = [
    {
      handleLLMEnd(output: unknown) {
        o.onUsage(usageOf(output as LlmEndOutput, o.model))
      },
    },
  ]
  const effort = o.effort && o.effort !== "default" ? o.effort : undefined
  const baseURL = resolveBaseUrl("chatgpt", o.baseUrl ?? "") || "https://api.openai.com/v1"

  return new ChatOpenAI({
    model: o.model,
    apiKey: "managed-chatgpt-token",
    useResponsesApi: true,
    streaming: true,
    configuration: {
      baseURL,
      defaultHeaders: attributionHeaders(baseURL),
      fetch: async (url, init) => {
        // Resolve valid access token per request via auth service or session parser
        const token = await resolveChatGPTAccessToken(o.apiKey, globalChatGPTService)

        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${token}`)
        headers.set("Accept", "text/event-stream")

        let bodyObj: any = {}
        if (init?.body) {
          try {
            bodyObj = JSON.parse(String(init.body))
          } catch {
            bodyObj = {}
          }
        }
        bodyObj.store = false
        bodyObj.stream = true

        return globalThis.fetch(url, {
          ...init,
          headers,
          body: JSON.stringify(bodyObj),
        })
      },
    },
    temperature: 0.2,
    streamUsage: true,
    ...(effort ? { modelKwargs: { reasoning_effort: effort } } : {}),
    callbacks,
  })
}

export function makeModel(o: ModelOptions): BaseChatModel {
  if (o.provider === "chatgpt") {
    return createChatGPTResponsesModel(o)
  }

  const callbacks = [
    {
      handleLLMEnd(output: unknown) {
        o.onUsage(usageOf(output as LlmEndOutput, o.model))
      },
    },
  ]
  const effort = o.effort && o.effort !== "default" ? o.effort : undefined
  const baseURL = resolveBaseUrl(o.provider, o.baseUrl ?? "")
  // An empty base URL would send the key to the client library's own default endpoint.
  if (PROVIDERS[o.provider].kind === "openai" && !baseURL) throw new Error(`Set the base URL of your ${PROVIDERS[o.provider].label} first.`)
  if (PROVIDERS[o.provider].kind === "openai")
    return new ChatOpenAI({
      model: o.model,
      apiKey: o.apiKey,
      configuration: { baseURL, defaultHeaders: attributionHeaders(baseURL) },
      temperature: 0.2,
      streamUsage: true,
      ...(effort ? { modelKwargs: { reasoning_effort: effort } } : {}),
      callbacks,
    })
  return new ChatOpenRouter({
    model: o.model,
    apiKey: o.apiKey,
    models: fallbackModels(o.model),
    provider: { data_collection: "deny" },
    temperature: 0.2,
    // OpenRouter's unified reasoning setting; models without reasoning ignore it.
    ...(effort ? { modelKwargs: { reasoning: { effort } } } : {}),
    siteUrl: "https://github.com/protonspy/harness-for-rea",
    siteName: "Harness for REA",
    callbacks,
  })
}
