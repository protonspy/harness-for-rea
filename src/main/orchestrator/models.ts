import { PROVIDERS, resolveBaseUrl, resolveEndpointUrl, validateReasoningEffort, type ModelProtocol, type ProviderId } from "@shared/providers"
import type { ChatGPTModelOption, OrchestratorEffort, ProbeResult, ProbeStatus } from "@shared/types"
import { attributionHeaders } from "./attribution"
import { friendlyError } from "./errors"
import { OPENAI_RESPONSES_URL, resolveChatGPTAccessToken } from "../chatgpt"
import { getChatGPTAuthService } from "./model"
import { fetchRiverResponses } from "./river-responses"

/*
  The models a provider offers, read from its `GET {baseUrl}/models` (the OpenAI list endpoint that
  DeepSeek and most compatible servers implement) so the user picks instead of typing. Runs in main so
  the key never reaches the renderer. OpenRouter lists hundreds, so only those that advertise tool
  calling and take images in are kept: the orchestrator cannot run without tools, and a screenshot or a
  decoded resource is evidence it has to read. A model that advertises neither field is kept, since
  nothing says it lacks them.
*/

interface ModelEntry {
  id?: unknown
  supported_parameters?: unknown
  architecture?: { input_modalities?: unknown }
}

/** Whether an OpenRouter entry can call tools and read images, as far as it says. */
function capable(m: ModelEntry): boolean {
  const tools = !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools")
  const input = m.architecture?.input_modalities
  return tools && (!Array.isArray(input) || input.includes("image"))
}

const TIMEOUT_MS = 10_000
/** A test request waits for one token, which a cold model can take a while to give. */
const TEST_TIMEOUT_MS = 30_000

export async function listChatGPTModels(o?: { baseUrl?: string; apiKey?: string | null }): Promise<ChatGPTModelOption[]> {
  const base = resolveBaseUrl("chatgpt", o?.baseUrl ?? PROVIDERS.chatgpt.baseUrl)
  if (!base) throw new Error("Set a base URL first.")

  let token: string | null = null
  try {
    token = await resolveChatGPTAccessToken(o?.apiKey, getChatGPTAuthService())
  } catch {
    token = null
  }
  if (!token) {
    throw new Error("Connect your ChatGPT account to list available models.")
  }

  let res: Response
  try {
    res = await fetch(`${base}/models`, {
      headers: {
        ...attributionHeaders(base),
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`Could not reach ${base}/models: ${(e as Error).message}`, { cause: e })
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw friendlyError({ status: 401 }, PROVIDERS.chatgpt.label)
    throw new Error(`${PROVIDERS.chatgpt.label} answered ${res.status} to the model list.${res.status === 404 ? versionHint(base) : ""}`)
  }

  const body = (await res.json().catch(() => null)) as {
    models?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }>
  } | null

  if (!Array.isArray(body?.models)) {
    throw new Error(`${base}/models did not return a ChatGPT model list.`)
  }

  const seen = new Set<string>()
  const result: ChatGPTModelOption[] = []
  for (const m of body.models) {
    if (m.visibility !== "list") continue
    const slug = (m.slug || m.id)?.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    const displayName = m.display_name?.trim() || slug
    result.push({ slug, displayName })
  }

  return result
}

export async function listModels(o: { provider: ProviderId; baseUrl: string; apiKey: string | null }): Promise<string[]> {
  const base = resolveBaseUrl(o.provider, o.baseUrl)
  if (!base) throw new Error("Set a base URL first.")

  if (o.provider === "chatgpt") {
    const opts = await listChatGPTModels(o)
    return opts.map((m) => m.slug)
  }

  let res: Response
  try {
    res = await fetch(`${base}/models`, {
      headers: {
        ...attributionHeaders(base),
        accept: "application/json",
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`Could not reach ${base}/models: ${(e as Error).message}`, { cause: e })
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 402 || res.status === 429)
      throw friendlyError({ status: res.status }, PROVIDERS[o.provider].label)
    throw new Error(`${PROVIDERS[o.provider].label} answered ${res.status} to the model list.${res.status === 404 ? versionHint(base) : ""}`)
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  if (!Array.isArray(body?.data)) throw new Error(`${base}/models did not return a model list.`)
  const ids = (body.data as ModelEntry[])
    .filter((m) => typeof m.id === "string" && m.id !== "")
    .filter((m) => o.provider !== "openrouter" || capable(m))
    .map((m) => m.id as string)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/** For a 404 at a base URL with no version in its path: where the API most likely is. */
export function versionHint(base: string): string {
  let path = ""
  try {
    path = new URL(base).pathname
  } catch {
    return ""
  }
  return /\/v\d+\/?$/.test(path) ? "" : ` Most services serve the API under /v1: try ${base.replace(/\/+$/, "")}/v1 as the base URL.`
}

/** Whether a failure is the provider refusing the key: the one answer a test request cannot get past. */
export const refusedKey = (e: unknown) => {
  const s = (e as { status?: number })?.status
  return s === 401 || s === 403
}

export interface ProbeOptions {
  provider: ProviderId
  baseUrl: string
  apiKey: string | null
  model: string
  protocol?: ModelProtocol
  effort?: OrchestratorEffort
}

/** Token budget for model probing: ensures reasoning models have sufficient tokens to emit thinking without immediate truncation or refusal. */
export const PROBE_BUDGET_TOKENS = 128

export async function probeModelStructured(o: ProbeOptions): Promise<ProbeResult> {
  const base = resolveBaseUrl(o.provider, o.baseUrl)
  if (!base) {
    return { ok: false, status: "error", reason: "Set a base URL first." }
  }
  const label = PROVIDERS[o.provider].label

  // Validate reasoning effort if explicitly configured
  if (o.effort && o.effort !== "default") {
    try {
      validateReasoningEffort(o.provider, o.model, o.effort)
    } catch (e) {
      return { ok: false, status: "error", reason: (e as Error).message }
    }
  }

  const explicitEffort = o.effort && o.effort !== "default" ? o.effort : undefined

  if (o.provider === "chatgpt" || o.protocol === "responses") {
    const isChatGPT = o.provider === "chatgpt"
    const token = isChatGPT ? await resolveChatGPTAccessToken(o.apiKey, getChatGPTAuthService()) : o.apiKey
    const endpoint = isChatGPT ? OPENAI_RESPONSES_URL : resolveEndpointUrl(base, "responses")

    const reqBody: Record<string, unknown> = {
      model: o.model,
      input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
      store: false,
      stream: true,
    }
    if (!isChatGPT) {
      reqBody.max_output_tokens = PROBE_BUDGET_TOKENS
    }
    if (explicitEffort) {
      reqBody.reasoning = { effort: explicitEffort }
    }

    let res: Response
    try {
      const request = o.provider === "river" ? fetchRiverResponses : globalThis.fetch
      res = await request(endpoint, {
        method: "POST",
        headers: {
          ...attributionHeaders(base),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(o.provider === "river" ? 90_000 : TEST_TIMEOUT_MS),
      })
    } catch (e) {
      return { ok: false, status: "error", reason: `Could not reach ${endpoint}: ${(e as Error).message}` }
    }

    if (!res.ok) {
      let status: ProbeStatus = "error"
      if (res.status === 401) status = "invalid_key"
      else if (res.status === 403) status = "forbidden"
      else if (res.status === 402) status = "quota_exceeded"
      else if (res.status === 404) status = "model_not_found"
      else if (res.status === 429) status = "rate_limited"

      const detail = await res.text().catch(() => "")
      const errSaid = /"message"\s*:\s*"([^"]{1,200})"/.exec(detail)?.[1] ?? ""
      const reason = errSaid || `${label} answered ${res.status} to a test request to ${o.model}.${res.status === 404 ? versionHint(base) : ""}`
      return { ok: false, status, reason }
    }

    const streamText = await res.text().catch(() => "")
    let completed = false
    let truncated = false
    let hasReasoning = false
    let failureMsg = ""

    for (const line of streamText.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("data:")) {
        const payloadStr = trimmed.slice(5).trim()
        if (!payloadStr || payloadStr === "[DONE]") continue
        try {
          const parsed = JSON.parse(payloadStr) as {
            type?: string
            event?: string
            error?: { message?: string } | null
            response?: {
              status?: string
              error?: { message?: string } | null
              incomplete_details?: { reason?: string }
            }
          }
          const eventType = parsed.type || parsed.event
          if (eventType === "response.completed") {
            completed = true
          } else if (eventType === "response.incomplete") {
            const incReason = parsed.response?.incomplete_details?.reason
            if (incReason === "max_output_tokens") {
              completed = true
              truncated = true
            }
          } else if (
            eventType === "response.reasoning.delta" ||
            eventType === "response.reasoning_text.delta" ||
            eventType === "response.reasoning_summary_text.delta" ||
            (eventType === "response.output_item.added" && (parsed as any).item?.type === "reasoning")
          ) {
            hasReasoning = true
          } else if (eventType === "response.failed" || eventType === "error") {
            const errObj = parsed.response?.error || parsed.error
            failureMsg = errObj && typeof errObj === "object" && errObj.message ? errObj.message : "response.failed"
          }
        } catch {
          // ignore non-json SSE lines
        }
      }
    }

    if (failureMsg) {
      return { ok: false, status: "error", reason: `${label} test request failed: ${failureMsg}` }
    }
    if (!completed) {
      return { ok: false, status: "error", reason: `${label} test stream ended before response.completed was received.` }
    }

    return {
      ok: true,
      status: "ready",
      reason: "",
      hasReasoning,
      truncated,
    }
  }

  const chatEndpoint = resolveEndpointUrl(base, "chat/completions")
  const chatBody: Record<string, unknown> = {
    model: o.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: o.provider === "river" ? PROBE_BUDGET_TOKENS : 1,
  }
  if (explicitEffort) {
    chatBody.reasoning_effort = explicitEffort
  }

  let res: Response
  try {
    res = await fetch(chatEndpoint, {
      method: "POST",
      headers: {
        ...attributionHeaders(base),
        "content-type": "application/json",
        accept: "application/json",
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify(chatBody),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, status: "error", reason: `Could not reach ${chatEndpoint}: ${(e as Error).message}` }
  }

  if (!res.ok) {
    let status: ProbeStatus = "error"
    if (res.status === 401) status = "invalid_key"
    else if (res.status === 403) status = "forbidden"
    else if (res.status === 402) status = "quota_exceeded"
    else if (res.status === 404) status = "model_not_found"
    else if (res.status === 429) status = "rate_limited"

    const detail = await res.text().catch(() => "")
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(detail)?.[1] ?? ""
    const reason = said
      ? `${label} answered ${res.status} to a test request to ${o.model}: ${said}`
      : `${label} answered ${res.status} to a test request to ${o.model}.${res.status === 404 ? versionHint(base) : ""}`
    return { ok: false, status, reason }
  }

  const rawText = await res.text().catch(() => "")
  let json: {
    choices?: Array<{
      message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: unknown[] }
      finish_reason?: string
    }>
    error?: { message?: string }
    usage?: { completion_tokens?: number }
    type?: string
    response?: { id?: string; status?: string }
    status?: string
  } | null = null

  try {
    json = JSON.parse(rawText)
  } catch {
    if (rawText.includes("data:")) {
      for (const line of rawText.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("data:")) {
          const payload = trimmed.slice(5).trim()
          if (payload && payload !== "[DONE]") {
            try {
              const parsed = JSON.parse(payload)
              if (parsed.choices || parsed.response || parsed.type === "response.completed" || parsed.id) {
                json = parsed
                break
              }
            } catch {}
          }
        }
      }
    }
  }

  if (json?.type === "response.completed" || json?.response?.status === "completed" || json?.status === "completed") {
    return { ok: true, status: "ready", reason: "" }
  }

  if (json?.error?.message) {
    return { ok: false, status: "error", reason: json.error.message }
  }

  const choice = json?.choices?.[0]
  const message = choice?.message
  const hasReasoning = Boolean(message?.reasoning_content || message?.reasoning)
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
  const hasContent = typeof message?.content === "string" && message.content.length > 0
  const truncated = choice?.finish_reason === "length"
  const tokensOut = json?.usage?.completion_tokens

  // A model that returns reasoning, tool calls, content, or was truncated after generating tokens is valid and operational
  if (hasReasoning || hasToolCalls || hasContent || truncated) {
    return {
      ok: true,
      status: "ready",
      reason: "",
      hasReasoning,
      hasToolCalls,
      truncated,
      tokensOut,
    }
  }

  if (!json) {
    return {
      ok: false,
      status: "error",
      reason: `${label} returned invalid JSON or empty response.`,
    }
  }

  return {
    ok: false,
    status: "unverified",
    reason: `${label} returned a response with no content, reasoning, or tool calls.`,
  }
}

/**
  A structured test request to the chosen model (specs/onboarding R1.6). Throws on failure or returns ProbeResult on success.
*/
export async function probeModel(o: ProbeOptions): Promise<ProbeResult> {
  const result = await probeModelStructured(o)
  if (!result.ok) {
    const label = PROVIDERS[o.provider]?.label ?? o.provider
    if (result.status === "invalid_key") throw friendlyError({ status: 401 }, label)
    if (result.status === "forbidden") throw friendlyError({ status: 403 }, label)
    if (result.status === "quota_exceeded") throw friendlyError({ status: 402 }, label)
    if (result.status === "rate_limited") throw friendlyError({ status: 429 }, label)
    throw friendlyError(new Error(result.reason), label)
  }
  return result
}
