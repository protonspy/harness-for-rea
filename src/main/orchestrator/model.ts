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

function enforceResponsesCompletionStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  let completed = false
  let terminalError: Error | null = null

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const dataStr = trimmed.slice(5).trim()
          if (!dataStr || dataStr === "[DONE]") continue

          try {
            const parsed = JSON.parse(dataStr)
            if (parsed.type === "response.completed") {
              completed = true
            } else if (parsed.type === "response.failed") {
              const reason = parsed.response?.error?.message ?? parsed.error?.message ?? "response.failed"
              terminalError = new Error(`ChatGPT Responses stream failed: ${reason}`)
              controller.error(terminalError)
              return
            } else if (parsed.type === "response.incomplete") {
              const reason = parsed.response?.incomplete_details?.reason ?? "response.incomplete"
              terminalError = new Error(`ChatGPT Responses stream incomplete: ${reason}`)
              controller.error(terminalError)
              return
            }
          } catch {
            // Non-JSON SSE event line, ignore
          }
        }

        if (!terminalError) {
          controller.enqueue(chunk)
        }
      },
      flush(controller) {
        if (terminalError) {
          controller.error(terminalError)
          return
        }
        if (!completed) {
          controller.error(new Error("ChatGPT Responses stream terminated prematurely without response.completed."))
        }
      },
    }),
  )
}

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

        // SIWC parameter restrictions: omit temperature, top_p, and unsupported metadata fields (D1)
        delete bodyObj.temperature
        delete bodyObj.top_p
        delete bodyObj.user
        delete bodyObj.background
        delete bodyObj.conversation
        delete bodyObj.max_output_tokens
        delete bodyObj.max_tool_calls
        delete bodyObj.metadata
        delete bodyObj.moderation
        delete bodyObj.multi_agent
        delete bodyObj.prompt
        delete bodyObj.prompt_cache_retention
        delete bodyObj.safety_identifier
        delete bodyObj.top_logprobs
        delete bodyObj.truncation
        delete bodyObj.previous_response_id

        // SIWC message restrictions: use developer role instead of system message (D1)
        if (Array.isArray(bodyObj.input)) {
          for (const item of bodyObj.input) {
            if (item && item.type === "message" && item.role === "system") {
              item.role = "developer"
            }
          }
        }

        // SIWC tools restrictions: pass function/custom tools via additional_tools input item (D1)
        if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
          const tools = bodyObj.tools
          delete bodyObj.tools
          bodyObj.input = bodyObj.input || []
          bodyObj.input.unshift({
            type: "additional_tools",
            tools,
          })
        }

        const res = await globalThis.fetch(url, {
          ...init,
          headers,
          body: JSON.stringify(bodyObj),
        })

        if (res.ok && res.body) {
          const wrappedBody = enforceResponsesCompletionStream(res.body)
          return new Response(wrappedBody, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        }

        return res
      },
    },
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
