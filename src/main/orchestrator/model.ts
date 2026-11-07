import { attributionHeaders } from "./attribution"
import { AsyncLocalStorage } from "node:async_hooks"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { BaseMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"

const activeMessagesStorage = new AsyncLocalStorage<readonly BaseMessage[] | BaseMessage[]>()

class ReasoningChatOpenAI extends ChatOpenAI {
  constructor(fields?: ConstructorParameters<typeof ChatOpenAI>[0]) {
    super(fields)
    const completionsAny = (this as any).completions
    if (completionsAny) {
      if (typeof completionsAny["_generate"] === "function") {
        const origGen = completionsAny["_generate"].bind(completionsAny)
        completionsAny["_generate"] = (messages: any, options: any, runManager: any) => {
          return activeMessagesStorage.run(messages, () => origGen(messages, options, runManager))
        }
      }
      if (typeof completionsAny["_streamResponseChunks"] === "function") {
        const origStream = completionsAny["_streamResponseChunks"].bind(completionsAny)
        completionsAny["_streamResponseChunks"] = async function* (messages: any, options: any, runManager: any) {
          yield* activeMessagesStorage.run(messages, () => origStream(messages, options, runManager))
        }
      }
    }
  }

  override async invoke(input: any, options?: any) {
    const messages = Array.isArray(input) ? input : input?.messages ? input.messages : [input]
    return activeMessagesStorage.run(messages, () => super.invoke(input, options))
  }

  override async stream(input: any, options?: any) {
    const messages = Array.isArray(input) ? input : input?.messages ? input.messages : [input]
    return activeMessagesStorage.run(messages, () => super.stream(input, options))
  }
}
import { ChatOpenRouter } from "@langchain/openrouter"
import { estimateCostUsd, getModelPricing, getRiverModelPricing, type CacheHypothesis, type CostStatus, type ModelRateSnapshot } from "@shared/pricing"
import { PRESET_MODEL } from "@shared/defaults"
import { PROVIDERS, resolveBaseUrl, validateReasoningEffort, type ModelProtocol, type ProviderId } from "@shared/providers"
import type { OrchestratorEffort } from "@shared/types"
import { resolveChatGPTAccessToken, type ChatGPTAuthService } from "../chatgpt"
import { fetchRiverResponses, RIVER_INFERENCE_TIMEOUT_MS } from "./river-responses"

/*
  The orchestrator's chat model (specs/orchestrator R1, adr:0014-add-openai-compatible-orchestrator-providers).
  On OpenRouter: any model the user picked, with the preset as the fallback in OpenRouter's `models`
  routing and provider data collection denied since source code is sent. On any other provider: the
  OpenAI chat API at the provider's base URL, DeepSeek's being one preset. Supports explicit protocol
  selection between Chat Completions and Responses API. Each call's usage and cost is handed to `onUsage`.
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
  cacheTokens?: number
  costUsd: number
  costStatus: CostStatus
  estimate: boolean
  model: string
  rateSnapshot?: ModelRateSnapshot
  cacheHypothesis?: CacheHypothesis
  promptTokensIncludesCache?: boolean
}

export function fallbackModels(model: string): string[] {
  return model === PRESET_MODEL ? [model] : [model, PRESET_MODEL]
}

interface LlmEndOutput {
  llmOutput?: {
    tokenUsage?: {
      prompt_tokens?: number
      completion_tokens?: number
      cost?: number
      prompt_tokens_details?: { cached_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      input_tokens?: number
      output_tokens?: number
      cost?: number
      prompt_tokens_details?: { cached_tokens?: number }
      input_tokens_details?: { cached_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
      output_tokens_details?: { reasoning_tokens?: number }
    }
  }
  generations?: {
    message?: {
      response_metadata?: {
        model_name?: string
        model?: string
        cost?: number
        tokenUsage?: {
          prompt_tokens?: number
          completion_tokens?: number
          cost?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          input_tokens?: number
          output_tokens?: number
          cost?: number
          prompt_tokens_details?: { cached_tokens?: number }
          input_tokens_details?: { cached_tokens?: number }
        }
      }
      usage_metadata?: {
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
        input_token_details?: {
          cache_read?: number
          cached_tokens?: number
        }
        output_token_details?: {
          reasoning?: number
          reasoning_tokens?: number
        }
      }
    }
  }[][]
}

/** One completed call's usage, evaluating reported cost or catalog pricing snapshot. */
export function usageOf(output: LlmEndOutput, fallback: string, provider?: ProviderId): ModelUsage {
  const rawTokenUsage = output.llmOutput?.tokenUsage
  const rawUsage = (output.llmOutput as any)?.usage
  const msg = output.generations?.[0]?.[0]?.message
  const respMeta = (msg as any)?.response_metadata
  const respTokenUsage = respMeta?.tokenUsage
  const respUsage = respMeta?.usage
  const usageMeta = (msg as any)?.usage_metadata

  const tokensIn =
    rawTokenUsage?.prompt_tokens ??
    rawUsage?.prompt_tokens ??
    rawUsage?.input_tokens ??
    respTokenUsage?.prompt_tokens ??
    respUsage?.prompt_tokens ??
    respUsage?.input_tokens ??
    usageMeta?.input_tokens ??
    0

  const tokensOut =
    rawTokenUsage?.completion_tokens ??
    rawUsage?.completion_tokens ??
    rawUsage?.output_tokens ??
    respTokenUsage?.completion_tokens ??
    respUsage?.completion_tokens ??
    respUsage?.output_tokens ??
    usageMeta?.output_tokens ??
    0

  const rawCache =
    rawTokenUsage?.prompt_tokens_details?.cached_tokens ??
    rawUsage?.prompt_tokens_details?.cached_tokens ??
    rawUsage?.input_tokens_details?.cached_tokens ??
    respTokenUsage?.prompt_tokens_details?.cached_tokens ??
    respUsage?.prompt_tokens_details?.cached_tokens ??
    respUsage?.input_tokens_details?.cached_tokens ??
    usageMeta?.input_token_details?.cache_read ??
    usageMeta?.input_token_details?.cached_tokens

  const cacheTokens = typeof rawCache === "number" && !isNaN(rawCache) ? rawCache : undefined
  const model = respMeta?.model_name ?? respMeta?.model ?? fallback

  const costCandidates: unknown[] = [
    rawTokenUsage?.cost,
    rawUsage?.cost,
    respTokenUsage?.cost,
    respUsage?.cost,
    respMeta?.cost,
    (output.llmOutput as any)?.cost,
    usageMeta?.cost,
  ]
  const reportedCost = costCandidates.find((c): c is number => typeof c === "number" && Number.isFinite(c))

  if (typeof reportedCost === "number") {
    return {
      tokensIn,
      tokensOut,
      cacheTokens,
      costUsd: reportedCost,
      costStatus: "reported",
      estimate: false,
      model,
      promptTokensIncludesCache: true,
    }
  }

  const pricing = provider ? getModelPricing(provider, model) : getRiverModelPricing(model)
  if (pricing) {
    const est = estimateCostUsd(tokensIn, cacheTokens, tokensOut, pricing)
    return {
      tokensIn,
      tokensOut,
      cacheTokens,
      costUsd: est.costUsd,
      costStatus: "estimated",
      estimate: true,
      model,
      rateSnapshot: est.rateSnapshot,
      cacheHypothesis: est.cacheHypothesis,
      promptTokensIncludesCache: true,
    }
  }

  return {
    tokensIn,
    tokensOut,
    cacheTokens,
    costUsd: 0,
    costStatus: "unknown",
    estimate: false,
    model,
    promptTokensIncludesCache: true,
  }
}

export interface ModelOptions {
  provider: ProviderId
  /** the endpoint of an OpenAI-compatible provider; OpenRouter ignores it */
  baseUrl?: string
  apiKey: string
  model: string
  effort?: OrchestratorEffort
  protocol?: ModelProtocol
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

export function enforceResponsesCompletionStream(body: ReadableStream<Uint8Array>, label = "Responses"): ReadableStream<Uint8Array> {
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
            const type = parsed.type || parsed.event
            if (type === "response.completed") {
              completed = true
            } else if (type === "response.failed" || type === "error") {
              const reason = parsed.response?.error?.message ?? parsed.error?.message ?? "response.failed"
              terminalError = new Error(`${label} stream failed: ${reason}`)
              controller.error(terminalError)
              return
            } else if (type === "response.incomplete") {
              const reason = parsed.response?.incomplete_details?.reason ?? "response.incomplete"
              terminalError = new Error(`${label} stream incomplete: ${reason}`)
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
          controller.error(new Error(`${label} stream terminated prematurely without response.completed.`))
        }
      },
    }),
  )
}

export function createResponsesModel(o: ModelOptions): BaseChatModel {
  validateReasoningEffort(o.provider, o.model, o.effort)
  const callbacks = [
    {
      handleLLMEnd(output: unknown) {
        o.onUsage(usageOf(output as LlmEndOutput, o.model, o.provider))
      },
    },
  ]
  const effort = o.effort && o.effort !== "default" ? o.effort : undefined
  const isChatGPT = o.provider === "chatgpt"
  const label = isChatGPT ? "ChatGPT Responses" : `${PROVIDERS[o.provider]?.label ?? "River"} Responses`
  const baseURL = resolveBaseUrl(o.provider, o.baseUrl ?? "") || (isChatGPT ? "https://api.openai.com/v1" : "")

  return new ChatOpenAI({
    model: o.model,
    apiKey: isChatGPT ? "managed-chatgpt-token" : o.apiKey || "no-key",
    useResponsesApi: true,
    streaming: true,
    ...(o.provider === "river" ? { maxRetries: 0, timeout: RIVER_INFERENCE_TIMEOUT_MS } : {}),
    configuration: {
      baseURL,
      ...(o.provider === "river" ? { maxRetries: 0 } : {}),
      defaultHeaders: attributionHeaders(baseURL),
      fetch: async (url, init) => {
        // Resolve valid access token per request via auth service or session parser for ChatGPT
        const token = isChatGPT ? await resolveChatGPTAccessToken(o.apiKey, globalChatGPTService) : o.apiKey

        const headers = new Headers(init?.headers)
        if (token) {
          headers.set("Authorization", `Bearer ${token}`)
        }
        headers.set("Accept", "text/event-stream")

        let bodyObj: any = {}
        if (init?.body) {
          try {
            bodyObj = JSON.parse(String(init.body))
          } catch {
            bodyObj = {}
          }
        }

        // River & Responses Contract: send full history, store:false, stream:true
        bodyObj.store = false
        bodyObj.stream = true

        // Explicit reasoning effort configuration for Responses API; default omits parameter
        if (effort) {
          bodyObj.reasoning = { effort }
        } else {
          delete bodyObj.reasoning
        }
        delete bodyObj.reasoning_effort

        // Omit unsupported parameters
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

        if (isChatGPT) {
          // ChatGPT Responses API message restrictions: map system messages to developer role
          if (Array.isArray(bodyObj.input)) {
            for (const item of bodyObj.input) {
              if (item && item.type === "message" && item.role === "system") {
                item.role = "developer"
              }
            }
          }

          // SIWC / ChatGPT plan token sharing restrictions: pass tools via additional_tools input item with role: "developer"
          if (bodyObj.tools && Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
            const tools = bodyObj.tools
            delete bodyObj.tools
            for (const tool of tools) {
              if (tool && tool.strict === null) {
                delete tool.strict
              }
            }
            bodyObj.input = bodyObj.input || []
            const existingIdx = bodyObj.input.findIndex((i: any) => i && i.type === "additional_tools")
            const additionalToolsItem = {
              type: "additional_tools",
              role: "developer" as const,
              tools,
            }
            if (existingIdx >= 0) {
              bodyObj.input[existingIdx] = additionalToolsItem
            } else {
              bodyObj.input.unshift(additionalToolsItem)
            }
          }

          // Guarantee any existing additional_tools item carries role: "developer" and sanitized schemas
          if (Array.isArray(bodyObj.input)) {
            for (const item of bodyObj.input) {
              if (item && item.type === "additional_tools") {
                item.role = "developer"
                if (Array.isArray(item.tools)) {
                  for (const tool of item.tools) {
                    if (tool && tool.strict === null) {
                      delete tool.strict
                    }
                  }
                }
              }
            }
          }
        }

        const request = o.provider === "river" ? fetchRiverResponses : globalThis.fetch
        const res = await request(url, {
          ...init,
          headers,
          body: JSON.stringify(bodyObj),
        })

        if (res.ok && res.body) {
          const contentType = res.headers.get("content-type") ?? ""
          if (contentType.includes("text/event-stream")) {
            const wrappedBody = enforceResponsesCompletionStream(res.body, label)
            return new Response(wrappedBody, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            })
          }
        }

        return res
      },
    },
    streamUsage: true,
    ...(effort ? { modelKwargs: { reasoning_effort: effort, reasoning: { effort } } } : {}),
    callbacks,
  })
}

export const createChatGPTResponsesModel = createResponsesModel

export function makeModel(o: ModelOptions): BaseChatModel {
  validateReasoningEffort(o.provider, o.model, o.effort)
  const protocol = o.protocol ?? (o.provider === "chatgpt" ? "responses" : "chat_completions")
  if (o.provider === "chatgpt" || protocol === "responses") {
    return createResponsesModel(o)
  }

  const callbacks = [
    {
      handleLLMEnd(output: unknown) {
        o.onUsage(usageOf(output as LlmEndOutput, o.model, o.provider))
      },
    },
  ]
  const effort = o.effort && o.effort !== "default" ? o.effort : undefined
  const baseURL = resolveBaseUrl(o.provider, o.baseUrl ?? "")
  // An empty base URL would send the key to the client library's own default endpoint.
  if (PROVIDERS[o.provider].kind === "openai" && !baseURL) throw new Error(`Set the base URL of your ${PROVIDERS[o.provider].label} first.`)
  if (PROVIDERS[o.provider].kind === "openai")
    return new ReasoningChatOpenAI({
      model: o.model,
      apiKey: o.apiKey,
      configuration: {
        baseURL,
        defaultHeaders: attributionHeaders(baseURL),
        fetch: async (url, init) => {
          if (init?.body) {
            try {
              const bodyObj = JSON.parse(String(init.body))
              const origMessages = activeMessagesStorage.getStore()

              // Preserve reasoning_content and tool calls on assistant history messages without confusing reasoning with final content
              if (Array.isArray(bodyObj.messages)) {
                let aiIdx = 0
                const aiMessages = origMessages
                  ? (origMessages as any[]).filter((m) => m?.getType?.() === "ai" || m?.constructor?.name?.includes("AI") || m?.role === "assistant")
                  : []

                for (const m of bodyObj.messages) {
                  if (m && m.role === "assistant") {
                    const match = aiMessages[aiIdx++]
                    const reasoning =
                      match?.additional_kwargs?.reasoning_content ?? match?.additional_kwargs?.reasoning ?? match?.reasoning_content ?? m.reasoning_content
                    if (reasoning !== undefined) {
                      m.reasoning_content = reasoning
                    }
                    if (m.content === null || m.content === undefined) {
                      m.content = ""
                    }
                  }
                }
              }
              if (effort) {
                bodyObj.reasoning_effort = effort
              } else {
                delete bodyObj.reasoning_effort
              }
              init = { ...init, body: JSON.stringify(bodyObj) }
            } catch {
              // Non-JSON body, proceed unchanged
            }
          }
          return globalThis.fetch(url, init)
        },
      },
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
