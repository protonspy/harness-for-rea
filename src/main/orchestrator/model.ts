import { attributionHeaders } from "./attribution"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import { ChatOpenRouter } from "@langchain/openrouter"
import { PRESET_MODEL } from "@shared/defaults"
import { PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import type { OrchestratorEffort } from "@shared/types"
import { OPENAI_RESPONSES_URL, resolveChatGPTAccessToken, type ChatGPTAuthService } from "../chatgpt"

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
 * with `store: false`, `stream: true`, per-request token resolution, and tool support.
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
    configuration: {
      baseURL,
      defaultHeaders: attributionHeaders(baseURL),
      fetch: async (_url, init) => {
        // Resolve valid access token per request via auth service or session parser
        const token = await resolveChatGPTAccessToken(o.apiKey, globalChatGPTService)

        // Target official Responses API
        const targetUrl = OPENAI_RESPONSES_URL

        let bodyObj: any = {}
        try {
          bodyObj = JSON.parse(String(init?.body ?? "{}"))
        } catch {
          bodyObj = {}
        }

        // Map Chat Completions messages to Responses input format
        const input = (bodyObj.messages ?? []).map((m: any) => {
          let role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user"
          if (m.role === "tool") role = "tool"
          let content = m.content
          if (typeof content === "string") {
            content = [{ type: "input_text", text: content }]
          }
          return { role, content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) }
        })

        // Map tools to Responses API format
        const tools = (bodyObj.tools ?? []).map((t: any) => ({
          type: "function",
          name: t.function?.name ?? t.name,
          description: t.function?.description ?? t.description,
          parameters: t.function?.parameters ?? t.parameters ?? {},
        }))

        const responsesPayload = {
          model: bodyObj.model || o.model,
          input: input.length ? input : [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          store: false,
          stream: true,
          ...(tools.length ? { tools } : {}),
        }

        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${token}`)
        headers.set("Content-Type", "application/json")
        headers.set("Accept", "text/event-stream")

        const res = await globalThis.fetch(targetUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(responsesPayload),
          signal: init?.signal,
        })

        if (!res.ok) {
          return res
        }

        // Consume SSE stream ensuring response.completed is reached
        const streamText = await res.text().catch(() => "")
        let content = ""
        let toolCalls: any[] = []
        let completed = false
        let failed = false
        let failureError: string | undefined
        let usage = { prompt_tokens: 0, completion_tokens: 0 }

        for (const line of streamText.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const payloadStr = trimmed.slice(5).trim()
          if (!payloadStr || payloadStr === "[DONE]") continue

          try {
            const data = JSON.parse(payloadStr)
            const eventType = data.type || data.event
            if (eventType === "response.text.delta" && data.delta) {
              content += data.delta
            } else if (eventType === "response.output_item.added" && data.item?.type === "function_call") {
              toolCalls.push({
                id: data.item.call_id || data.item.id || `call_${toolCalls.length + 1}`,
                type: "function",
                function: { name: data.item.name, arguments: data.item.arguments || "" },
              })
            } else if (eventType === "response.function_call_arguments.done") {
              const existing = toolCalls.find((t) => t.id === (data.call_id || data.item_id))
              if (existing) {
                existing.function.arguments = data.arguments || existing.function.arguments
              } else {
                toolCalls.push({
                  id: data.call_id || data.item_id || `call_${toolCalls.length + 1}`,
                  type: "function",
                  function: { name: data.name, arguments: data.arguments },
                })
              }
            } else if (eventType === "response.completed") {
              completed = true
              if (data.response?.usage) {
                usage.prompt_tokens = data.response.usage.input_tokens || 0
                usage.completion_tokens = data.response.usage.output_tokens || 0
              }
            } else if (eventType === "response.failed" || eventType === "error") {
              failed = true
              failureError = data.response?.error?.message || data.error?.message || "Inference failed"
            } else if (eventType === "response.incomplete") {
              failed = true
              failureError = "Inference stream incomplete"
            }
          } catch {
            // Ignore non-json lines
          }
        }

        if (failed) {
          throw new Error(failureError ?? "Inference failed.")
        }
        if (!completed) {
          throw new Error("Response stream ended before response.completed was received.")
        }

        const chatCompletionResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: o.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: content || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls.length ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
          },
        }

        return new Response(JSON.stringify(chatCompletionResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
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
