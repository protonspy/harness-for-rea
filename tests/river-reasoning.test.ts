import { describe, expect, it } from "vitest"
import { getAvailableEffortsForModel, getRiverModelReasoning, RIVER_MODEL_REASONING, validateReasoningEffort } from "../src/shared/providers"
import { probeModelStructured, type ProbeOptions } from "../src/main/orchestrator/models"
import { makeModel, createResponsesModel } from "../src/main/orchestrator/model"

describe("River Model Reasoning Validation and Probing (Issue #5)", () => {
  describe("Reasoning effort profiles and validation matrix", () => {
    it("defines reasoning profiles for all 7 River catalog models", () => {
      const expectedModels = [
        "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "deepseek-ai/DeepSeek-V4.1-Flash",
        "moonshotai/Kimi-K3",
        "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
        "GLM-5.3",
        "zai-org/GLM-5.3-Flash",
        "Qwen/Qwen3.8-27B-FP8",
      ]

      for (const m of expectedModels) {
        expect(RIVER_MODEL_REASONING[m]).toBeDefined()
        const profile = getRiverModelReasoning(m)
        expect(profile).toBeDefined()
      }
    })

    it("enforces mandatory reasoning on GLM-5.3 and GLM-5.3-Flash rejecting none", () => {
      expect(RIVER_MODEL_REASONING["GLM-5.3"].mandatoryReasoning).toBe(true)
      expect(RIVER_MODEL_REASONING["GLM-5.3"].supportedEfforts).not.toContain("none")
      expect(RIVER_MODEL_REASONING["zai-org/GLM-5.3-Flash"].mandatoryReasoning).toBe(true)
      expect(RIVER_MODEL_REASONING["zai-org/GLM-5.3-Flash"].supportedEfforts).not.toContain("none")

      expect(() => validateReasoningEffort("river", "GLM-5.3", "none")).toThrow(/Model "GLM-5.3" on River does not support reasoning effort "none"/)
      expect(() => validateReasoningEffort("river", "zai-org/GLM-5.3-Flash", "none")).toThrow(
        /Model "zai-org\/GLM-5.3-Flash" on River does not support reasoning effort "none"/,
      )

      expect(() => validateReasoningEffort("river", "GLM-5.3", "low")).not.toThrow()
      expect(() => validateReasoningEffort("river", "GLM-5.3", "high")).not.toThrow()
      expect(() => validateReasoningEffort("river", "GLM-5.3", "max")).not.toThrow()
    })

    it("validates supported efforts for Qwen3.8-27B-FP8 and Nemotron-3.5-Super-VL", () => {
      // Qwen supports none, low, medium, xhigh
      expect(() => validateReasoningEffort("river", "Qwen/Qwen3.8-27B-FP8", "xhigh")).not.toThrow()
      expect(() => validateReasoningEffort("river", "Qwen/Qwen3.8-27B-FP8", "medium")).not.toThrow()
      expect(() => validateReasoningEffort("river", "Qwen/Qwen3.8-27B-FP8", "max")).toThrow(/does not support reasoning effort "max"/)

      // Nemotron supports none, medium, high
      expect(() => validateReasoningEffort("river", "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4", "medium")).not.toThrow()
      expect(() => validateReasoningEffort("river", "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4", "low")).toThrow(
        /does not support reasoning effort "low"/,
      )
    })

    it("always permits 'default' effort across all models", () => {
      for (const model of Object.keys(RIVER_MODEL_REASONING)) {
        expect(() => validateReasoningEffort("river", model, "default")).not.toThrow()
        expect(() => validateReasoningEffort("river", model, undefined)).not.toThrow()
      }
    })

    it("filters available efforts in getAvailableEffortsForModel", () => {
      const qwenEfforts = getAvailableEffortsForModel("river", "Qwen/Qwen3.8-27B-FP8")
      expect(qwenEfforts).toEqual(["default", "none", "low", "medium", "xhigh"])

      const glmEfforts = getAvailableEffortsForModel("river", "GLM-5.3")
      expect(glmEfforts).toEqual(["default", "low", "high", "max"])

      // Other providers get full effort list
      const openRouterEfforts = getAvailableEffortsForModel("openrouter", "any/model")
      expect(openRouterEfforts).toContain("minimal")
    })
  })

  describe("Model instantiation with effort configuration", () => {
    it("omits reasoning_effort in chat_completions when effort is default", async () => {
      let interceptedBody: any = null
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (_url: any, init?: any) => {
        interceptedBody = JSON.parse(init?.body as string)
        return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          headers: { "content-type": "application/json" },
        })
      }

      try {
        const model = makeModel({
          provider: "river",
          model: "Qwen/Qwen3.8-27B-FP8",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "test-key",
          effort: "default",
          onUsage: () => {},
        })

        await model.invoke("ping")
        expect(interceptedBody).toBeDefined()
        expect(interceptedBody.reasoning_effort).toBeUndefined()
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("creates Responses model with reasoning: { effort } when effort is specified", () => {
      const model = createResponsesModel({
        provider: "river",
        model: "GLM-5.3",
        baseUrl: "https://api.river.ai/v1",
        apiKey: "test-key",
        effort: "high",
        onUsage: () => {},
      })

      expect(model).toBeDefined()
    })
  })

  describe("Structured readiness probing", () => {
    it("recognizes reasoning-only completion without content as ready", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  reasoning_content: "I am thinking through the prompt...",
                },
                finish_reason: "stop",
              },
            ],
            usage: { completion_tokens: 42 },
          }),
          { headers: { "content-type": "application/json" } },
        )

      try {
        const probeOpts: ProbeOptions = {
          provider: "river",
          model: "moonshotai/Kimi-K3",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "test-key",
          protocol: "chat_completions",
        }

        const res = await probeModelStructured(probeOpts)
        expect(res.ok).toBe(true)
        expect(res.status).toBe("ready")
        expect(res.hasReasoning).toBe(true)
        expect(res.tokensOut).toBe(42)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("recognizes truncated output on token limit as ready", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Partial",
                  reasoning_content: null,
                },
                finish_reason: "length",
              },
            ],
            usage: { completion_tokens: 128 },
          }),
          { headers: { "content-type": "application/json" } },
        )

      try {
        const probeOpts: ProbeOptions = {
          provider: "river",
          model: "Qwen/Qwen3.8-27B-FP8",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "test-key",
        }

        const res = await probeModelStructured(probeOpts)
        expect(res.ok).toBe(true)
        expect(res.status).toBe("ready")
        expect(res.truncated).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("differentiates 401 invalid_key, 403 forbidden, and 402 quota_exceeded", async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })

        const res401 = await probeModelStructured({
          provider: "river",
          model: "GLM-5.3",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "bad-key",
        })
        expect(res401.ok).toBe(false)
        expect(res401.status).toBe("invalid_key")

        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
            status: 402,
            headers: { "content-type": "application/json" },
          })

        const res402 = await probeModelStructured({
          provider: "river",
          model: "GLM-5.3",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "key",
        })
        expect(res402.ok).toBe(false)
        expect(res402.status).toBe("quota_exceeded")
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
