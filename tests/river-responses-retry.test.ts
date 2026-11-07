import { afterEach, describe, expect, it, vi } from "vitest"
import { setTimeout as delay } from "node:timers/promises"
import { fetchRiverResponses, RIVER_INFERENCE_TIMEOUT_MS } from "../src/main/orchestrator/river-responses"
import { makeModel } from "../src/main/orchestrator/model"
import { probeModelStructured } from "../src/main/orchestrator/models"
import { friendlyError } from "../src/main/orchestrator/errors"

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async (_ms, _value, options) => options?.signal?.throwIfAborted()) }))

const endpoint = "https://api.river.ai/v1/responses"
const failed = { type: "response.failed", response: { error: { code: "server_error", message: "Inference is temporarily unavailable. Please retry." } } }
const completed = {
  type: "response.completed",
  response: { id: "resp_ok", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 7 } },
}
const textDelta = { type: "response.output_text.delta", delta: "Recovered" }
const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
const stream = (...events: unknown[]) => new Response(sse(...events), { headers: { "content-type": "text/event-stream" } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(delay).mockClear()
})

describe("River transient Responses failures", () => {
  it("recovers the reported HTTP 200 response.failed through model.invoke and records only successful usage", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => stream({ type: "response.created" }, failed))
      .mockImplementationOnce(async () => stream(textDelta, completed))
    const onUsage = vi.fn()
    const model = makeModel({ provider: "river", apiKey: "rv-test", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", protocol: "responses", onUsage })
    const result = await model.invoke("ping")
    expect(JSON.stringify(result.content)).toContain("Recovered")
    expect(fetch).toHaveBeenCalledTimes(2)
    const requests = fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body, auth: new Headers(init?.headers).get("authorization") }))
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0].url).toBe(endpoint)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0]).toMatchObject({ tokensIn: 12, tokensOut: 7 })
  })

  it("uses the same recovery policy for the model test in setup", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => stream(failed))
      .mockImplementationOnce(async () => stream(completed))
    const result = await probeModelStructured({
      provider: "river",
      baseUrl: "https://api.river.ai/v1",
      apiKey: "rv-test",
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      protocol: "responses",
    })
    expect(result.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("limits persistent failures to three requests, including the SDK and LangChain layers", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => stream(failed))
    const model = makeModel({ provider: "river", apiKey: "rv-test", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", protocol: "responses", onUsage: vi.fn() })
    await expect(model.invoke("ping")).rejects.toThrow("Inference is temporarily unavailable")
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([expect.any(Number), expect.any(Number)])
    expect(vi.mocked(delay).mock.calls[0][0]).toBeGreaterThanOrEqual(1000)
    expect(vi.mocked(delay).mock.calls[1][0]).toBeGreaterThanOrEqual(2000)
  })

  it.each([429, 500, 502, 503, 504])("recovers transient HTTP %s and releases its body", async (status) => {
    const cancel = vi.fn()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => new Response(new ReadableStream({ cancel }), { status, headers: { "retry-after": "5" } }))
      .mockImplementationOnce(async () => stream(completed))
    const response = await fetchRiverResponses(endpoint)
    expect(await response.text()).toContain("response.completed")
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(5000, undefined, { signal: expect.any(AbortSignal) })
  })

  it.each([400, 401, 402, 403, 404, 422])("does not retry permanent HTTP %s", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status }))
    expect((await fetchRiverResponses(endpoint)).status).toBe(status)
    expect(fetch).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
  })

  it("does not retry a permanent SSE error", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => stream({ type: "error", error: { code: "invalid_request_error", message: "Context length exceeded" } }))
    expect(await (await fetchRiverResponses(endpoint)).text()).toContain("Context length exceeded")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    textDelta,
    { type: "response.output_item.added", item: { type: "function_call", name: "inspect_binary", call_id: "call_1" } },
    { type: "response.reasoning_text.delta", delta: "Thinking" },
  ])("never replays a request after output: $type", async (output) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => stream(output, failed))
    const response = await fetchRiverResponses(endpoint)
    expect(await response.text()).toBe(sse(output, failed))
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("recognizes failures split across arbitrary byte chunks with CRLF delimiters", async () => {
    const wire = sse({ type: "response.created" }, failed).replaceAll("\n", "\r\n")
    const encoder = new TextEncoder()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const char of wire) controller.enqueue(encoder.encode(char))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      .mockImplementationOnce(async () => stream(completed))
    expect(await (await fetchRiverResponses(endpoint)).text()).toContain("response.completed")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("preserves streaming after the first output without waiting for completion", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            upstream = controller
            controller.enqueue(new TextEncoder().encode(sse(textDelta)))
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const response = await fetchRiverResponses(endpoint)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("Recovered")
    expect(upstream!).toBeDefined()
    await reader.cancel()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("cancels during backoff without making another request", async () => {
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort()
      return new Response("Unavailable", { status: 503 })
    })
    await expect(fetchRiverResponses(endpoint, { signal: controller.signal })).rejects.toThrow(/abort/i)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("does not make a request when already aborted", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    await expect(fetchRiverResponses(endpoint, { signal: AbortSignal.abort() })).rejects.toThrow(/abort/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sets a ten minute serving deadline and returns actionable guidance after exhaustion", async () => {
    expect(RIVER_INFERENCE_TIMEOUT_MS).toBe(600_000)
    const error = friendlyError(new Error(`River Responses stream failed: ${failed.response.error.message}`), "River")
    expect(error.message).toContain("select another River model")
    expect(error.message).toContain("https://status.river.ai")
    expect(error.message).not.toContain("API key")
  })
})
