import { afterEach, describe, expect, it, vi } from "vitest"
import { attributionHeaders } from "../src/main/orchestrator/attribution"
import { makeModel } from "../src/main/orchestrator/model"
import { listModels, probeModel } from "../src/main/orchestrator/models"

const baseUrl = "https://api.withhopper.com/v1"
const model = "deepseek-v4.1-flash-1017-abliterated"
afterEach(() => vi.unstubAllGlobals())

describe("Hopper client attribution", () => {
  it("is restricted to the exact HTTPS Hopper origin", () => {
    expect(attributionHeaders(baseUrl)).toEqual({ "X-Hopper-Client": "harness-for-rea" })
    for (const base of [
      "http://api.withhopper.com/v1",
      "https://api.withhopper.com.evil.example/v1",
      "https://api.withhopper.com:8443/v1",
      "https://openrouter.ai/api/v1",
      "http://localhost:8080/v1",
      "invalid",
    ])
      expect(attributionHeaders(base)).toEqual({})
  })

  it("tags listing and probe requests while preserving the user's key", async () => {
    const seen: Request[] = []
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const req = new Request(input, init)
      seen.push(req)
      return Response.json(req.url.endsWith("/models") ? { data: [{ id: model }] } : { choices: [{ message: { content: "pong" } }] })
    })
    const options = { provider: "custom" as const, baseUrl, apiKey: "test-key", model }
    expect(await listModels(options)).toEqual([model])
    await probeModel(options)
    expect(seen.map((r) => r.url)).toEqual([`${baseUrl}/models`, `${baseUrl}/chat/completions`])
    for (const req of seen) {
      expect(req.headers.get("x-hopper-client")).toBe("harness-for-rea")
      expect(req.headers.get("authorization")).toBe("Bearer test-key")
    }
  })

  it.each([false, true])("tags actual SDK requests (stream=%s)", async (stream) => {
    const seen: Request[] = []
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const req = new Request(input, init)
      seen.push(req)
      const body = {
        id: "test",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      if (!stream) return Response.json(body)
      return new Response(
        `data: ${JSON.stringify({ ...body, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const client = makeModel({ provider: "custom", baseUrl, apiKey: "test-key", model, onUsage: () => undefined })
    if (stream) {
      let content = ""
      for await (const chunk of await client.stream("hello")) content += chunk.content
      expect(content).toBe("ok")
    } else expect((await client.invoke("hello")).content).toBe("ok")
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.get("x-hopper-client")).toBe("harness-for-rea")
    expect(seen[0].headers.get("authorization")).toBe("Bearer test-key")
  })
})
