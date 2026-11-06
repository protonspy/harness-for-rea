import { describe, expect, it } from "vitest"
import { RIVER_CONSOLE_KEYS_URL, RIVER_DOCS_INFERENCE_URL, RIVER_MODELS_URL, RiverAuthService, type Fetch } from "../src/main/river"
import { PROVIDERS, groupModels, resolveBaseUrl } from "../src/shared/providers"
import { attributionHeaders } from "../src/main/orchestrator/attribution"
import { API_SCHEMAS } from "../src/shared/api"
import { listModels, refusedKey } from "../src/main/orchestrator/models"
import { makeModel } from "../src/main/orchestrator/model"
import { friendlyError } from "../src/main/orchestrator/errors"
import { classifyAgentFailure, AgentSpecialist } from "../src/main/specialist/agent"
import { ContainerBackend } from "../src/main/specialist/container"
import { readiness, type ReadinessDeps } from "../src/main/readiness"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { LoginStatus, SandboxStatus } from "../src/shared/types"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"

describe("River authentication investigation (specs/river-auth, adr:0029)", () => {
  it("reports that official browser login is not supported and directs to River Console (R1.1, R1.2, R1.4)", () => {
    const service = new RiverAuthService()
    const cap = service.capability()

    expect(cap.hasOfficialBrowserLogin).toBe(false)
    expect(cap.supportedAuthMethod).toBe("api_key")
    expect(cap.consoleUrl).toBe(RIVER_CONSOLE_KEYS_URL)
    expect(cap.docsUrl).toBe(RIVER_DOCS_INFERENCE_URL)
    expect(cap.message).toContain("No public documented browser authorization")
    expect(service.hasOfficialBrowserLoginFlow()).toBe(false)
  })

  it("explicitly rejects browser sign-in requests with the console keys URL (R1.3, R1.4)", async () => {
    const service = new RiverAuthService()
    await expect(service.startBrowserSignIn()).rejects.toThrow(/River AI does not support browser authorization.*https:\/\/console\.river\.ai\/keys/)
  })

  it("rejects empty keys immediately without network calls (R2.3)", async () => {
    let called = false
    const mockFetch: Fetch = async () => {
      called = true
      return new Response("{}", { status: 200 })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("   ")

    expect(result.valid).toBe(false)
    expect(result.error).toBe("River API key cannot be empty.")
    expect(called).toBe(false)
  })

  // Finding 1 regression: keys with newlines/control characters do not cause unhandled header exceptions
  it("rejects keys with newlines or control characters safely without exposing secrets (Finding 1)", async () => {
    let called = false
    const mockFetch: Fetch = async () => {
      called = true
      return new Response("{}", { status: 200 })
    }

    const service = new RiverAuthService(mockFetch)
    const badKey = "rv_FAKE_REVIEW_ONLY\ninvalid"
    const result = await service.validateKey(badKey)

    expect(result.valid).toBe(false)
    expect(result.error).toBe("River API key contains invalid characters.")
    expect(result.error).not.toContain("rv_FAKE_REVIEW_ONLY")
    expect(called).toBe(false)
  })

  // Finding 1 regression: exceptions during fetch containing the secret are redacted
  it("redacts credentials from unexpected transport or header exception messages (Finding 1)", async () => {
    const secretKey = "rv_SECRET_KEY_999888"
    const mockFetch: Fetch = async () => {
      throw new Error(`Headers.append: "Bearer ${secretKey}" is an invalid header value.`)
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey(secretKey)

    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(secretKey)
    expect(result.error).toContain("[redacted]")
  })

  // Finding 2 regression: requests strictly target the fixed official HTTPS endpoint
  it("always targets the official HTTPS /v1/models endpoint without accepting arbitrary URLs (Finding 2)", async () => {
    let requestedUrl = ""
    let capturedAuth = ""
    const mockFetch: Fetch = async (url, init) => {
      requestedUrl = url
      capturedAuth = String((init.headers as Record<string, string>)["Authorization"])
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_test_key_12345")

    expect(result.valid).toBe(true)
    expect(requestedUrl).toBe(RIVER_MODELS_URL)
    expect(capturedAuth).toBe("Bearer rv_test_key_12345")
  })

  // Finding 3 regression: HTML 200 responses are rejected as invalid non-JSON
  it("rejects HTTP 200 with HTML content as invalid non-JSON response (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response("<html><body>Login Page</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned invalid or non-JSON response.")
  })

  // Finding 3 regression: malformed JSON responses are rejected
  it("rejects HTTP 200 with malformed JSON (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response("{ not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned invalid or non-JSON response.")
  })

  // Finding 3 regression: unexpected response structure missing data array is rejected
  it("rejects HTTP 200 missing the data array (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ unexpected: "payload" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response missing models data array.")
  })

  // Finding 3 regression: HTTP 200 containing error payload is handled cleanly
  it("rejects HTTP 200 containing an error object in body (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Internal proxy gateway failure" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned error: Internal proxy gateway failure")
  })

  // Finding 3 regression: rejects malformed model entries (null, primitives, objects without id)
  it("rejects HTTP 200 with malformed model entries such as null, primitives or objects without id (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ data: [null, {}, 7] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key", "GLM-5.3")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response contains malformed model entries.")
  })

  // Finding 3 regression: rejects numeric or non-string model IDs
  it("rejects HTTP 200 with non-string model id (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ data: [{ id: 9 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response contains invalid model ID.")
  })

  // Finding 3 regression: rejects empty or whitespace-only model IDs
  it("rejects HTTP 200 with empty or blank model id string (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ data: [{ id: "   " }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response contains invalid model ID.")
  })

  // Finding 3 regression: rejects array with mixture of valid and invalid entries
  it("rejects HTTP 200 with mixed valid and invalid model entries (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ data: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }, null] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response contains malformed model entries.")
  })

  // Finding 3 regression: valid empty catalog is authenticated and returns modelsCount = 0
  it("distinguishes valid empty catalog as authenticated with modelsCount 0 (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key")

    expect(result.valid).toBe(true)
    expect(result.status).toBe(200)
    expect(result.modelsCount).toBe(0)
    expect(result.models).toEqual([])
  })

  // Finding 3 regression: populated catalog with model availability check
  it("validates populated catalog and reports whether selected model is present (Finding 3)", async () => {
    const catalog = [
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model" },
      { id: "GLM-5.3", object: "model" },
    ]
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ object: "list", data: catalog }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)

    const withModel = await service.validateKey("rv_valid_key", "deepseek-ai/DeepSeek-V4.1-Flash")
    expect(withModel.valid).toBe(true)
    expect(withModel.modelsCount).toBe(2)
    expect(withModel.models).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash", "GLM-5.3"])
    expect(withModel.hasModel).toBe(true)

    const withoutModel = await service.validateKey("rv_valid_key", "non-existent-model")
    expect(withoutModel.valid).toBe(true)
    expect(withoutModel.hasModel).toBe(false)
  })

  it("classifies HTTP 401 as invalid key without leaking key content in error (R2.2, R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const secretKey = "rv_super_secret_token_abcdef"
    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey(secretKey)

    expect(result.valid).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid River API key.")
    expect(result.error).not.toContain(secretKey)
  })

  it("classifies HTTP 403 as forbidden permissions (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Permission denied" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key_no_perm")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toBe("River account does not have access or permissions for this endpoint.")
  })

  it("classifies HTTP 429 as quota or rate limit exceeded (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key_quota")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(429)
    expect(result.error).toBe("River rate limit exceeded or credit quota exhausted.")
  })

  it("handles upstream network failures gracefully (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.river.ai")
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key")

    expect(result.valid).toBe(false)
    expect(result.error).toContain("River could not be reached: getaddrinfo ENOTFOUND api.river.ai")
  })
})

describe("River native provider and model catalog (Issue #3)", () => {
  it("registers river as an independent OpenAI-compatible preset in PROVIDERS", () => {
    expect(PROVIDERS.river).toBeDefined()
    expect(PROVIDERS.river.id).toBe("river")
    expect(PROVIDERS.river.label).toBe("River")
    expect(PROVIDERS.river.kind).toBe("openai")
    expect(PROVIDERS.river.baseUrl).toBe("https://api.river.ai/v1")
    expect(PROVIDERS.river.editableBaseUrl).toBe(false)
    expect(PROVIDERS.river.keyRequired).toBe(true)
    expect(PROVIDERS.river.defaultModel).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017")
    expect(PROVIDERS.river.models).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "GLM-5.3",
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      "zai-org/GLM-5.3-Flash",
      "Qwen/Qwen3.8-27B-FP8",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "moonshotai/Kimi-K3",
    ])
    expect(PROVIDERS.river.signupUrl).toBe("https://console.river.ai/keys")
    expect(resolveBaseUrl("river", "")).toBe("https://api.river.ai/v1")
    expect(attributionHeaders(PROVIDERS.river.baseUrl)).toEqual({})
  })

  it("validates IPC contract schemas for River orchestrator and specialist models", () => {
    for (const model of PROVIDERS.river.models) {
      const patch = API_SCHEMAS.saveSettings.parse([{ provider: "river", model }])
      expect(patch[0].provider).toBe("river")
      expect(patch[0].model).toBe(model)

      const spPatch = API_SCHEMAS.saveSettings.parse([{ specialistProvider: "river", specialistModel: model }])
      expect(spPatch[0].specialistProvider).toBe("river")
      expect(spPatch[0].specialistModel).toBe(model)
    }
  })

  describe("Preset and catalog reconciliation in groupModels", () => {
    it("reconciles presets with discovery when account has a partial catalog", () => {
      const groups = groupModels("river", ["GLM-5.3"])
      expect(groups).toEqual([{ label: "Recommended", models: ["GLM-5.3"] }])
    })

    it("reconciles presets and places non-preset discovered models under Models", () => {
      const groups = groupModels("river", ["GLM-5.3", "river/custom-preview-model"])
      expect(groups).toEqual([
        { label: "Recommended", models: ["GLM-5.3"] },
        { label: "Models", models: ["river/custom-preview-model"] },
      ])
    })

    it("preserves all 7 preset models when discovery returns all of them", () => {
      const groups = groupModels("river", [...PROVIDERS.river.models])
      expect(groups).toEqual([{ label: "Recommended", models: [...PROVIDERS.river.models] }])
    })

    it("preserves all 7 presets in Recommended for manual entry on recoverable discovery failure or empty list", () => {
      const groups = groupModels("river", [])
      expect(groups).toEqual([{ label: "Recommended", models: [...PROVIDERS.river.models] }])
    })
  })

  describe("Model discovery and error distinction (Issue #3)", () => {
    it("listModels calls GET /v1/models with Bearer auth and no attribution headers", async () => {
      let capturedUrl = ""
      let capturedHeaders: Record<string, string> = {}
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        capturedUrl = String(url)
        capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        return new Response(
          JSON.stringify({
            data: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }, { id: "GLM-5.3" }, { id: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      try {
        const models = await listModels({
          provider: "river",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "rv_test_key_123",
        })
        expect(capturedUrl).toBe("https://api.river.ai/v1/models")
        expect(capturedHeaders["authorization"]).toBe("Bearer rv_test_key_123")
        expect(capturedHeaders["x-hopper-client"]).toBeUndefined()
        expect(models).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash-1017", "GLM-5.3", "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4"])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("distinguishes HTTP 401, 403, 402, and 429 without collapsing 403 into 401", async () => {
      const originalFetch = globalThis.fetch
      try {
        // 401
        globalThis.fetch = async () => new Response("Unauthorized", { status: 401 })
        await expect(listModels({ provider: "river", baseUrl: "https://api.river.ai/v1", apiKey: "bad_key" })).rejects.toThrow(/River rejected the API key/i)

        // 403
        globalThis.fetch = async () => new Response("Forbidden", { status: 403 })
        await expect(listModels({ provider: "river", baseUrl: "https://api.river.ai/v1", apiKey: "forbidden_key" })).rejects.toThrow(
          /Your River account does not have access or permissions/i,
        )

        // 402
        globalThis.fetch = async () => new Response("Payment Required", { status: 402 })
        await expect(listModels({ provider: "river", baseUrl: "https://api.river.ai/v1", apiKey: "no_credits" })).rejects.toThrow(/out of credits/i)

        // 429
        globalThis.fetch = async () => new Response("Rate limited", { status: 429 })
        await expect(listModels({ provider: "river", baseUrl: "https://api.river.ai/v1", apiKey: "rate_limited" })).rejects.toThrow(/rate-limiting/i)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("refusedKey returns true for 401 and 403 but false for 404 or 500", () => {
      expect(refusedKey({ status: 401 })).toBe(true)
      expect(refusedKey({ status: 403 })).toBe(true)
      expect(refusedKey({ status: 404 })).toBe(false)
      expect(refusedKey({ status: 500 })).toBe(false)
    })
  })

  describe("Chat completions, SSE streaming and tool calling (Issue #3)", () => {
    it("executes complete non-streaming response with ChatOpenAI at River endpoint", async () => {
      let interceptedUrl = ""
      let authHeader = ""
      let capturedBody: any = {}
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (url, init) => {
        interceptedUrl = String(url)
        authHeader = new Headers(init?.headers).get("Authorization") ?? ""
        capturedBody = JSON.parse(String(init?.body ?? "{}"))

        const responsePayload = {
          id: "chatcmpl-river-1",
          object: "chat.completion",
          created: 1700000000,
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "River response completed." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
        }
        return new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      let reportedUsage: any = null
      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv_secret_key_999",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          onUsage: (u) => {
            reportedUsage = u
          },
        })

        const res = await model.invoke([new HumanMessage("Hello River")])
        expect(interceptedUrl).toBe("https://api.river.ai/v1/chat/completions")
        expect(authHeader).toBe("Bearer rv_secret_key_999")
        expect(capturedBody.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017")
        expect(res.content).toBe("River response completed.")
        expect(reportedUsage).toMatchObject({
          tokensIn: 15,
          tokensOut: 8,
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        })
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("handles SSE streaming including chunks without choices and usage chunks", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        const sseStream = [
          'data: {"id":"chatcmpl-s1","choices":[],"usage":null}\n\n',
          'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"role":"assistant","content":"Streaming "},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"from "},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"River."},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"chatcmpl-s1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}\n\n',
          "data: [DONE]\n\n",
        ].join("")

        return new Response(sseStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv_stream_key",
          model: "zai-org/GLM-5.3-Flash",
          onUsage: () => {},
        })

        const stream = await model.stream([new HumanMessage("Stream test")])
        let accumulated = ""
        for await (const chunk of stream) {
          accumulated += String(chunk.content)
        }
        expect(accumulated).toBe("Streaming from River.")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("executes full two-way tool calling cycle with tool_calls, ToolMessage and final response", async () => {
      const requests: any[] = []
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        requests.push(body)

        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-tool-1",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_rv_123",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({ path: "/work/main.rs" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 25, completion_tokens: 12 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        } else {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-tool-2",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Analysis of main.rs complete: verified entrypoint.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 45, completion_tokens: 15 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv_tool_key",
          model: "Qwen/Qwen3.8-27B-FP8",
          onUsage: () => {},
        })

        const toolModel = (model as any).bindTools([
          {
            name: "read_file",
            description: "Read file contents",
            schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ])

        const step1 = await toolModel.invoke([new HumanMessage("Please inspect main.rs")])
        expect(step1.tool_calls).toHaveLength(1)
        expect(step1.tool_calls[0].name).toBe("read_file")
        expect(step1.tool_calls[0].id).toBe("call_rv_123")
        expect(step1.tool_calls[0].args).toEqual({ path: "/work/main.rs" })

        const step2 = await model.invoke([
          new HumanMessage("Please inspect main.rs"),
          step1,
          new ToolMessage({
            content: 'fn main() { println!("Hello"); }',
            tool_call_id: "call_rv_123",
          }),
        ])

        expect(requests).toHaveLength(2)
        expect(requests[1].messages).toHaveLength(3)
        expect(requests[1].messages[2].role).toBe("tool")
        expect(requests[1].messages[2].tool_call_id).toBe("call_rv_123")
        expect(step2.content).toContain("Analysis of main.rs complete")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("handles fragmented SSE tool call streaming without loss of arguments", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        const sseStream = [
          'data: {"id":"cmpl-tc","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_frag_1","type":"function","function":{"name":"execute","arguments":""}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl-tc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"com"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl-tc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\\": \\""}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl-tc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"cargo test\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"cmpl-tc","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join("")

        return new Response(sseStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv_frag_key",
          model: "moonshotai/Kimi-K3",
          onUsage: () => {},
        })

        const stream = await model.stream([new HumanMessage("Run test command")])
        let toolCallArgs = ""
        for await (const chunk of stream) {
          if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
            toolCallArgs += chunk.tool_call_chunks[0].args || ""
          }
        }
        expect(JSON.parse(toolCallArgs)).toEqual({ command: "cargo test" })
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("Readiness and catalog reconciliation in both roles", () => {
    const okSandbox: SandboxStatus = { docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "2.1.310" }
    const okLogin: LoginStatus = { loggedIn: true, method: "claude.ai", plan: "max", email: "a@b.c", inProgress: false, url: null, text: "", error: "" }

    function makeDeps(o: Partial<ReadinessDeps> = {}): ReadinessDeps {
      return {
        sandbox: async () => okSandbox,
        login: async () => okLogin,
        settings: () => ({
          ...DEFAULT_SETTINGS,
          provider: "river" as const,
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          specialistProvider: "claude" as const,
          specialistModel: "",
        }),
        keySet: () => true,
        listModels: async () => ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "GLM-5.3"],
        probeModel: async () => undefined,
        ...o,
      }
    }

    describe("Orchestrator role", () => {
      it("is ready when selected model is present in partial catalog", async () => {
        const d = makeDeps({
          settings: () => ({ ...DEFAULT_SETTINGS, provider: "river", model: "GLM-5.3" }),
          listModels: async () => ["GLM-5.3"],
        })
        const r = await readiness(d)
        expect(r.model).toMatchObject({ ready: true, provider: "river", model: "GLM-5.3" })
      })

      it("is not ready when selected model is absent from partial catalog", async () => {
        const d = makeDeps({
          settings: () => ({ ...DEFAULT_SETTINGS, provider: "river", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }),
          listModels: async () => ["GLM-5.3"],
        })
        const r = await readiness(d)
        expect(r.model).toMatchObject({
          ready: false,
          reason: 'The model "deepseek-ai/DeepSeek-V4.1-Flash-1017" is not available for your River account. Choose a model from the account\'s catalog.',
        })
      })

      it("preserves manual entry on recoverable discovery failure and validates via probeModel", async () => {
        let probeCalled = 0
        const d = makeDeps({
          settings: () => ({ ...DEFAULT_SETTINGS, provider: "river", model: "Qwen/Qwen3.8-27B-FP8" }),
          listModels: async () => Promise.reject(new Error("River answered 500 to the model list.")),
          probeModel: async () => void probeCalled++,
        })
        const r = await readiness(d)
        expect(probeCalled).toBe(1)
        expect(r.model).toMatchObject({ ready: true, provider: "river", model: "Qwen/Qwen3.8-27B-FP8" })
      })

      it("fails readiness without probe when discovery fails with refused key (401 / 403)", async () => {
        let probeCalled = 0
        const d = makeDeps({
          settings: () => ({ ...DEFAULT_SETTINGS, provider: "river", model: "GLM-5.3" }),
          listModels: async () =>
            Promise.reject(Object.assign(new Error("Your River account does not have access or permissions for this endpoint or model."), { status: 403 })),
          probeModel: async () => void probeCalled++,
        })
        const r = await readiness(d)
        expect(probeCalled).toBe(0)
        expect(r.model).toMatchObject({
          ready: false,
          reason: "Your River account does not have access or permissions for this endpoint or model.",
        })
      })
    })

    describe("Specialist role (specialistProvider: 'river')", () => {
      it("is ready when specialist model is present in partial catalog", async () => {
        const d = makeDeps({
          settings: () => ({
            ...DEFAULT_SETTINGS,
            specialistProvider: "river",
            specialistModel: "GLM-5.3",
          }),
          listModels: async () => ["GLM-5.3"],
        })
        const r = await readiness(d)
        expect(r.claude).toMatchObject({ ready: true, provider: "river", model: "GLM-5.3" })
      })

      it("is not ready when specialist model is absent from partial catalog", async () => {
        const d = makeDeps({
          settings: () => ({
            ...DEFAULT_SETTINGS,
            specialistProvider: "river",
            specialistModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          }),
          listModels: async () => ["GLM-5.3"],
        })
        const r = await readiness(d)
        expect(r.claude).toMatchObject({
          ready: false,
          reason: 'The model "deepseek-ai/DeepSeek-V4.1-Flash-1017" is not available for your River account. Choose a model from the account\'s catalog.',
        })
      })

      it("preserves manual entry on recoverable discovery failure and validates specialist via probeModel", async () => {
        let probeCalled = 0
        const d = makeDeps({
          settings: () => ({
            ...DEFAULT_SETTINGS,
            specialistProvider: "river",
            specialistModel: "Qwen/Qwen3.8-27B-FP8",
          }),
          listModels: async () => Promise.reject(new Error("Network timeout")),
          probeModel: async () => void probeCalled++,
        })
        const r = await readiness(d)
        expect(probeCalled).toBe(1)
        expect(r.claude).toMatchObject({ ready: true, provider: "river", model: "Qwen/Qwen3.8-27B-FP8" })
      })

      it("fails specialist readiness without probe when discovery fails with refused key (401 / 403)", async () => {
        let probeCalled = 0
        const d = makeDeps({
          settings: () => ({
            ...DEFAULT_SETTINGS,
            specialistProvider: "river",
            specialistModel: "GLM-5.3",
          }),
          listModels: async () => Promise.reject(Object.assign(new Error("River rejected the API key. Set a valid key in Settings."), { status: 401 })),
          probeModel: async () => void probeCalled++,
        })
        const r = await readiness(d)
        expect(probeCalled).toBe(0)
        expect(r.claude).toMatchObject({
          ready: false,
          reason: "River rejected the API key. Set a valid key in Settings.",
        })
      })
    })
  })

  describe("Error distinction 401 vs 403 during delegation in both roles", () => {
    describe("Orchestrator delegation errors (friendlyError)", () => {
      it("classifies HTTP 401 as rejected API key with Settings guidance", () => {
        const err = friendlyError({ status: 401, message: "Unauthorized" }, "River")
        expect((err as any).status).toBe(401)
        expect(err.message).toBe("River rejected the API key. Set a valid key in Settings.")
      })

      it("classifies HTTP 403 as endpoint or model permission denial with access guidance", () => {
        const err = friendlyError({ status: 403, message: "Forbidden" }, "River")
        expect((err as any).status).toBe(403)
        expect(err.message).toBe("Your River account does not have access or permissions for this endpoint or model.")
      })
    })

    describe("Specialist delegation errors (classifyAgentFailure and execution)", () => {
      it("classifies HTTP 401 as auth error with API key guidance", () => {
        const failure = classifyAgentFailure(Object.assign(new Error("Unauthorized"), { status: 401 }), "River")
        expect(failure.kind).toBe("auth")
        expect(failure.message).toBe("River refused the specialist's API key. Set a valid key in Settings.")
      })

      it("classifies HTTP 403 as auth error with permissions/model guidance", () => {
        const failure = classifyAgentFailure(Object.assign(new Error("Forbidden"), { status: 403 }), "River")
        expect(failure.kind).toBe("auth")
        expect(failure.message).toBe("Your River account does not have access or permissions for this endpoint or model.")
      })

      it("rejects specialist turn with distinct 403 permissions guidance when River endpoint responds 403", async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = async () => {
          return new Response(JSON.stringify({ error: { message: "Access denied to model GLM-5.3" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        }

        try {
          const specialist = new AgentSpecialist({
            model: (onUsage) => makeModel({ provider: "river", apiKey: "rv_test_key", model: "GLM-5.3", onUsage }),
            provider: "River",
            modelName: "GLM-5.3",
            backend: new ContainerBackend(async () => ({ code: 0, stdout: Buffer.from(""), stderr: "" }), "container-123"),
            tools: [],
            systemPrompt: "You are the specialist.",
            idleMs: 5000,
          })

          await expect(specialist.send("Run task")).rejects.toMatchObject({
            kind: "auth",
            message: "Your River account does not have access or permissions for this endpoint or model.",
          })
        } finally {
          globalThis.fetch = originalFetch
        }
      })
    })
  })

  const realKey = process.env.RIVER_API_KEY
  ;(realKey ? it : it.skip)("smoke test against live River API with configured credential", async () => {
    const models = await listModels({
      provider: "river",
      baseUrl: "https://api.river.ai/v1",
      apiKey: realKey!,
    })
    expect(models.length).toBeGreaterThan(0)
  })
})
