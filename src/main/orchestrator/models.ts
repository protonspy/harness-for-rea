import { PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import { attributionHeaders } from "./attribution"
import { friendlyError } from "./errors"
import { OPENAI_RESPONSES_URL, resolveChatGPTAccessToken } from "../chatgpt"
import { getChatGPTAuthService } from "./model"

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

export async function listModels(o: { provider: ProviderId; baseUrl: string; apiKey: string | null }): Promise<string[]> {
  const base = resolveBaseUrl(o.provider, o.baseUrl)
  if (!base) throw new Error("Set a base URL first.")

  if (o.provider === "chatgpt") {
    let token: string | null = null
    try {
      token = await resolveChatGPTAccessToken(o.apiKey, getChatGPTAuthService())
    } catch {
      token = null
    }

    let res: Response
    try {
      res = await fetch(`${base}/models`, {
        headers: {
          ...attributionHeaders(base),
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new Error(`Could not reach ${base}/models: ${(e as Error).message}`, { cause: e })
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw friendlyError({ status: 401 }, PROVIDERS[o.provider].label)
      throw new Error(`${PROVIDERS[o.provider].label} answered ${res.status} to the model list.${res.status === 404 ? versionHint(base) : ""}`)
    }

    const body = (await res.json().catch(() => null)) as {
      models?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }>
      data?: Array<{ id?: string }>
    } | null

    if (Array.isArray(body?.models)) {
      const slugs = body.models
        .filter((m) => m.visibility === "list" || !m.visibility)
        .map((m) => m.slug || m.id)
        .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
      return [...new Set(slugs)]
    }

    if (Array.isArray(body?.data)) {
      const ids = body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
    }

    throw new Error(`${base}/models did not return a model list.`)
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
    if (res.status === 401 || res.status === 403) throw friendlyError({ status: 401 }, PROVIDERS[o.provider].label)
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
export const refusedKey = (e: unknown) => (e as { status?: number })?.status === 401

/**
  A one-token request to the chosen model (specs/onboarding R1.6): how an OpenAI-compatible server that has no model
  list — many answer 404 to `GET /models` — shows that its endpoint, key and model work. Throws the provider's answer.
*/
export async function probeModel(o: { provider: ProviderId; baseUrl: string; apiKey: string | null; model: string }): Promise<void> {
  const base = resolveBaseUrl(o.provider, o.baseUrl)
  if (!base) throw new Error("Set a base URL first.")
  const label = PROVIDERS[o.provider].label

  if (o.provider === "chatgpt") {
    const token = await resolveChatGPTAccessToken(o.apiKey, getChatGPTAuthService())
    let res: Response
    try {
      res = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: o.model,
          input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          store: false,
          stream: true,
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
    } catch (e) {
      throw new Error(`Could not reach ${OPENAI_RESPONSES_URL}: ${(e as Error).message}`, { cause: e })
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw friendlyError({ status: 401 }, label)
      throw new Error(`${label} answered ${res.status} to a test request to ${o.model}.${res.status === 404 ? versionHint(base) : ""}`)
    }

    const streamText = await res.text().catch(() => "")
    let completed = false
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
            response?: { status?: string; error?: { message?: string } | null }
          }
          const eventType = parsed.type || parsed.event
          if (eventType === "response.completed") {
            completed = true
          } else if (eventType === "response.failed" || eventType === "error") {
            const errObj = parsed.response?.error || parsed.error
            if (errObj && typeof errObj === "object" && errObj.message) {
              throw new Error(`${label} test request failed: ${errObj.message}`)
            } else if (eventType === "response.failed") {
              throw new Error(`${label} test request failed: response.failed`)
            }
          }
        } catch (e) {
          if ((e as Error).message.includes("test request failed")) {
            throw e
          }
        }
      }
    }

    if (!completed) {
      throw new Error(`${label} test stream ended before response.completed was received.`)
    }
    return
  }

  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        ...attributionHeaders(base),
        "content-type": "application/json",
        accept: "application/json",
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: o.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`Could not reach ${base}/chat/completions: ${(e as Error).message}`, { cause: e })
  }
  if (res.ok) return
  if (res.status === 401 || res.status === 403) throw friendlyError({ status: 401 }, label)
  const detail = await res.text().catch(() => "")
  const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(detail)?.[1] ?? ""
  throw new Error(`${label} answered ${res.status} to a test request to ${o.model}${said ? `: ${said}` : "."}${res.status === 404 ? versionHint(base) : ""}`)
}
