import { setTimeout as delay } from "node:timers/promises"

export const RIVER_INFERENCE_TIMEOUT_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function isEmptyPreludeEvent(event: any): boolean {
  const type = event?.type ?? event?.event
  if (type === "response.created" || type === "response.in_progress") {
    return true
  }
  if (type === "response.output_item.added") {
    const item = event.item
    if (item && item.type === "message") {
      const content = item.content
      return !content || (Array.isArray(content) && content.length === 0)
    }
    return false
  }
  if (type === "response.content_part.added") {
    const part = event.part
    return part?.type === "output_text" && (part.text === "" || part.text === undefined || part.text === null)
  }
  return false
}

function isTransientInferenceError(event: any): boolean {
  const error = event?.response?.error ?? event?.error ?? event
  return (
    /^(server_error|service_unavailable|inference_unavailable|temporarily_unavailable)$/.test(error?.code ?? error?.type ?? "") ||
    /inference is temporarily unavailable/i.test(error?.message ?? "")
  )
}

/** Inspect only the stream prelude. Once any output starts, replay is unsafe. */
async function inspectPrelude(res: Response, signal: AbortSignal): Promise<{ response: Response; retryable: boolean }> {
  if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
    return { response: res, retryable: false }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let buffer = ""
  let retryable = false
  let inspecting = true
  let preludeBytes = 0

  const onAbort = () => {
    reader
      .cancel(signal.reason)
      .catch(() => {})
      .finally(() => {
        try {
          reader.releaseLock()
        } catch {}
      })
  }

  if (signal.aborted) {
    onAbort()
    throw signal.reason
  }
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    while (inspecting) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      preludeBytes += value.byteLength
      if (preludeBytes > 64 * 1024) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim().startsWith("data:")) continue
        const data = line.trim().slice(5).trim()
        if (!data) continue
        let event: any
        try {
          event = JSON.parse(data)
        } catch {
          inspecting = false
          break
        }
        const type = event?.type ?? event?.event
        if (type === "response.failed" || type === "error") {
          retryable = isTransientInferenceError(event)
          inspecting = false
          break
        }
        if (isEmptyPreludeEvent(event)) {
          continue
        }
        inspecting = false
        break
      }
    }
  } catch (error) {
    signal.removeEventListener("abort", onAbort)
    try {
      await reader.cancel().catch(() => {})
    } finally {
      try {
        reader.releaseLock()
      } catch {}
    }
    throw error
  } finally {
    signal.removeEventListener("abort", onAbort)
  }

  // Replay the inspected bytes unchanged, then continue streaming without buffering output.
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted) {
        controller.error(signal.reason)
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          reader
            .cancel(signal.reason)
            .catch(() => {})
            .finally(() => {
              try {
                reader.releaseLock()
              } catch {}
              controller.error(signal.reason)
            })
        },
        { once: true },
      )
    },
    async pull(controller) {
      if (signal.aborted) {
        controller.error(signal.reason)
        return
      }
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
        return
      }
      try {
        const { done, value } = await reader.read()
        if (done) {
          try {
            reader.releaseLock()
          } catch {}
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        try {
          reader.releaseLock()
        } catch {}
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        try {
          reader.releaseLock()
        } catch {}
      }
    },
  })
  return { response: new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }), retryable }
}

/** River can report a transient inference failure inside an HTTP 200 SSE stream. */
export async function fetchRiverResponses(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const timeoutMs = (init as any)?.timeoutMs ?? RIVER_INFERENCE_TIMEOUT_MS
  const transportTimeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init?.signal ? AbortSignal.any([init.signal, transportTimeoutSignal]) : transportTimeoutSignal

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const res = await globalThis.fetch(url, { ...init, signal })
    const inspected = res.ok ? await inspectPrelude(res, signal) : { response: res, retryable: RETRYABLE_STATUS.has(res.status) }
    if (!inspected.retryable || attempt === MAX_ATTEMPTS - 1) return inspected.response

    await inspected.response.body?.cancel()
    const retryAfter = res.headers.get("retry-after")
    const retryAfterMs = retryAfter ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0
    const backoffMs = 1000 * 2 ** attempt + Math.random() * 250
    await delay(Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0), undefined, { signal })
  }
}
