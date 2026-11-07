import { describe, expect, it } from "vitest"
import {
  estimateCostUsd,
  formatModelPricingDetails,
  formatModelPricingShort,
  getModelPricing,
  getRiverModelPricing,
  RIVER_MODEL_PRICING,
  RIVER_PRICING_METADATA,
} from "../src/shared/pricing"
import { usageOf } from "../src/main/orchestrator/model"
import { EventLog } from "../src/main/events/log"
import { openDb } from "../src/main/db"
import { usageByAgent } from "../src/renderer/src/lib/store"
import type { EventRow } from "../src/shared/types"

describe("River Pricing Catalog (Issue #6)", () => {
  it("contains all 7 River models with exact rates, currency, unit, origin, and reference date", () => {
    expect(RIVER_PRICING_METADATA.currency).toBe("USD")
    expect(RIVER_PRICING_METADATA.unit).toBe("USD / 1M tokens")
    expect(RIVER_PRICING_METADATA.origin).toBe("River Console reference capture")
    expect(RIVER_PRICING_METADATA.referenceDate).toBe("2026-11-04")

    const expectedRates: Record<string, { input: number; cached: number; output: number }> = {
      "deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.12, cached: 0.0024, output: 0.48 },
      "GLM-5.3": { input: 1.12, cached: 0.208, output: 3.52 },
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": { input: 0.07, cached: 0.024, output: 0.37 },
      "zai-org/GLM-5.3-Flash": { input: 0.12, cached: 0.024, output: 0.4 },
      "Qwen/Qwen3.8-27B-FP8": { input: 0.1, cached: 0.02, output: 2.0 },
      "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.12, cached: 0.0024, output: 0.48 },
      "moonshotai/Kimi-K3": { input: 3.0, cached: 0.3, output: 15.0 },
    }

    expect(Object.keys(RIVER_MODEL_PRICING).sort()).toEqual(Object.keys(expectedRates).sort())

    for (const [model, rates] of Object.entries(expectedRates)) {
      const entry = RIVER_MODEL_PRICING[model]
      expect(entry).toBeDefined()
      expect(entry.currency).toBe("USD")
      expect(entry.unit).toBe("USD / 1M tokens")
      expect(entry.origin).toBe("River Console reference capture")
      expect(entry.referenceDate).toBe("2026-11-04")
      expect(entry.rates.input).toBe(rates.input)
      expect(entry.rates.cached).toBe(rates.cached)
      expect(entry.rates.output).toBe(rates.output)
    }
  })

  it("resolves pricing flexibly by exact name, case-insensitively, or without org prefix", () => {
    expect(getRiverModelPricing("GLM-5.3")?.rates.input).toBe(1.12)
    expect(getRiverModelPricing("glm-5.3")?.rates.input).toBe(1.12)
    expect(getRiverModelPricing("DeepSeek-V4.1-Flash-1017")?.rates.input).toBe(0.12)
    expect(getRiverModelPricing("deepseek-ai/DeepSeek-V4.1-Flash-1017")?.rates.cached).toBe(0.0024)
    expect(getRiverModelPricing("kimi-k3")?.rates.output).toBe(15.0)
    expect(getRiverModelPricing("unknown-model")).toBeUndefined()

    expect(getModelPricing("river", "GLM-5.3")?.rates.output).toBe(3.52)
  })

  it("formats pricing summaries and detailed reference metadata for UI pickers", () => {
    const entry = getRiverModelPricing("deepseek-ai/DeepSeek-V4.1-Flash-1017")!
    expect(formatModelPricingShort(entry)).toBe("($0.12/$0.0024/$0.48 per 1M)")
    expect(formatModelPricingDetails(entry)).toBe("USD per 1M tokens: In $0.12 · Cache $0.0024 · Out $0.48 (River Console reference capture, 2026-11-04)")
  })
})

describe("Cost Estimation Formula & Acceptance Criteria (Issue #6)", () => {
  const deepseekPricing = getRiverModelPricing("deepseek-ai/DeepSeek-V4.1-Flash-1017")!

  it("matches DeepSeek example from issue specification: 1M in, 250k cache, 100k out = US$ 0.1386", () => {
    // Formula: ((1_000_000 - 250_000) * 0.12 + 250_000 * 0.0024 + 100_000 * 0.48) / 1_000_000 = 0.1386
    const res = estimateCostUsd(1_000_000, 250_000, 100_000, deepseekPricing)
    expect(res.costUsd).toBe(0.1386)
    expect(res.cacheHypothesis).toBe("exact")
    expect(res.rateSnapshot.inputRate).toBe(0.12)
    expect(res.rateSnapshot.cacheRate).toBe(0.0024)
    expect(res.rateSnapshot.outputRate).toBe(0.48)
  })

  it("handles zero cache correctly: 1M in, 0 cache, 100k out = US$ 0.1680", () => {
    // Formula: ((1_000_000 - 0) * 0.12 + 0 + 100_000 * 0.48) / 1_000_000 = 0.168
    const res = estimateCostUsd(1_000_000, 0, 100_000, deepseekPricing)
    expect(res.costUsd).toBe(0.168)
    expect(res.cacheHypothesis).toBe("exact")
  })

  it("handles total cache correctly: 1M in, 1M cache, 100k out = US$ 0.0504", () => {
    // Formula: (0 * 0.12 + 1_000_000 * 0.0024 + 100_000 * 0.48) / 1_000_000 = (2400 + 48000) / 1M = 0.0504
    const res = estimateCostUsd(1_000_000, 1_000_000, 100_000, deepseekPricing)
    expect(res.costUsd).toBe(0.0504)
    expect(res.cacheHypothesis).toBe("exact")
  })

  it("handles missing cache detail without inventing fake measurements (documents assumed_zero_cache hypothesis)", () => {
    const res = estimateCostUsd(1_000_000, undefined, 100_000, deepseekPricing)
    expect(res.costUsd).toBe(0.168)
    expect(res.cacheHypothesis).toBe("assumed_zero_cache")
  })

  it("applies output rate to total output without adding reasoning tokens twice", () => {
    // Kimi-K3: in 3.00, cached 0.30, output 15.00
    const kimi = getRiverModelPricing("moonshotai/Kimi-K3")!
    // output_tokens is 50_000 (which includes reasoning); do not add reasoning tokens again
    const res = estimateCostUsd(100_000, 20_000, 50_000, kimi)
    // uncached: 80k * 3.00 = 240,000; cache: 20k * 0.30 = 6,000; out: 50k * 15.00 = 750,000; total = 996,000 / 1M = 0.996
    expect(res.costUsd).toBe(0.996)
  })
})

describe("usageOf parsing and cost status classification (Issue #6)", () => {
  it("parses Chat Completions prompt_tokens, prompt_tokens_details.cached_tokens, and completion_tokens", () => {
    const usage = usageOf(
      {
        llmOutput: {
          tokenUsage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 100_000,
            prompt_tokens_details: { cached_tokens: 250_000 },
          },
        },
        generations: [[{ message: { response_metadata: { model_name: "deepseek-ai/DeepSeek-V4.1-Flash-1017" } } }]],
      },
      "default-model",
      "river",
    )

    expect(usage.tokensIn).toBe(1_000_000)
    expect(usage.cacheTokens).toBe(250_000)
    expect(usage.tokensOut).toBe(100_000)
    expect(usage.costUsd).toBe(0.1386)
    expect(usage.costStatus).toBe("estimated")
    expect(usage.estimate).toBe(true)
    expect(usage.rateSnapshot).toBeDefined()
    expect(usage.cacheHypothesis).toBe("exact")
    expect(usage.promptTokensIncludesCache).toBe(true)
  })

  it("parses Responses API input_tokens, input_tokens_details.cached_tokens, and output_tokens", () => {
    const usage = usageOf(
      {
        generations: [
          [
            {
              message: {
                response_metadata: {
                  model: "GLM-5.3",
                  usage: {
                    input_tokens: 500_000,
                    output_tokens: 50_000,
                    input_tokens_details: { cached_tokens: 100_000 },
                  },
                },
              },
            },
          ],
        ],
      },
      "fallback",
      "river",
    )

    // GLM-5.3: input 1.12, cached 0.208, output 3.52
    // uncached: 400k * 1.12 = 448,000; cache: 100k * 0.208 = 20,800; out: 50k * 3.52 = 176,000
    // total = 644,800 / 1M = 0.6448
    expect(usage.tokensIn).toBe(500_000)
    expect(usage.cacheTokens).toBe(100_000)
    expect(usage.tokensOut).toBe(50_000)
    expect(usage.costUsd).toBe(0.6448)
    expect(usage.costStatus).toBe("estimated")
  })

  it("prioritizes reported cost when provider returns usage.cost and marks estimate: false", () => {
    const usage = usageOf(
      {
        llmOutput: {
          tokenUsage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            cost: 0.05,
          },
        },
      },
      "qwen/qwen3.8-flash",
      "openrouter",
    )

    expect(usage.costUsd).toBe(0.05)
    expect(usage.costStatus).toBe("reported")
    expect(usage.estimate).toBe(false)
  })

  it("marks costStatus as unknown when model is not in catalog and provider does not report cost", () => {
    const usage = usageOf(
      {
        llmOutput: {
          tokenUsage: {
            prompt_tokens: 500,
            completion_tokens: 100,
          },
        },
      },
      "custom-private-model",
      "custom",
    )

    expect(usage.costStatus).toBe("unknown")
    expect(usage.costUsd).toBe(0)
    expect(usage.estimate).toBe(false)
    expect(usage.rateSnapshot).toBeUndefined()
  })
})

describe("Persistence, Aggregation & Old Tasks Migration (Issue #6)", () => {
  it("stores cache_tokens and rate snapshot in events and sums tokensIn without double-counting cache", () => {
    openDb(":memory:")
    const log = new EventLog(":memory:")

    const task = log.createTask({ request: "test pricing", sourceRoot: "/src", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" })

    // Simulate first model call: 1M in, 250k cached, 100k out
    log.append({
      taskId: task.id,
      agent: "orchestrator",
      kind: "model.call",
      summary: "deepseek: 1M in, 100k out",
      payload: {
        model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        tokensIn: 1_000_000,
        cacheTokens: 250_000,
        tokensOut: 100_000,
        costUsd: 0.1386,
        costStatus: "estimated",
        estimate: true,
        promptTokensIncludesCache: true,
        rateSnapshot: {
          currency: "USD",
          unit: "USD / 1M tokens",
          origin: "River Console reference capture",
          referenceDate: "2026-11-04",
          inputRate: 0.12,
          cacheRate: 0.0024,
          outputRate: 0.48,
        },
      },
    })
    log.addUsage(task.id, { tokensIn: 1_000_000, cacheTokens: 250_000, tokensOut: 100_000, costUsd: 0.1386 })

    // Second call: 500k in, 100k cached, 50k out
    log.append({
      taskId: task.id,
      agent: "orchestrator",
      kind: "model.call",
      summary: "deepseek: 500k in, 50k out",
      payload: {
        model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        tokensIn: 500_000,
        cacheTokens: 100_000,
        tokensOut: 50_000,
        costUsd: 0.07224,
        costStatus: "estimated",
        estimate: true,
        promptTokensIncludesCache: true,
      },
    })
    log.addUsage(task.id, { tokensIn: 500_000, cacheTokens: 100_000, tokensOut: 50_000, costUsd: 0.07224 })

    const updatedTask = log.getTask(task.id)
    expect(updatedTask.tokensIn).toBe(1_500_000)
    expect(updatedTask.cacheTokens).toBe(350_000)
    expect(updatedTask.tokensOut).toBe(150_000)

    const usage = log.usage(task.id)
    expect(usage).toHaveLength(1)
    const orchUsage = usage[0]!
    expect(orchUsage.agent).toBe("orchestrator")
    expect(orchUsage.calls).toBe(2)
    // Crucial check: tokensIn must be 1,500,000 (NOT 1,500,000 + 350,000 = 1,850,000!)
    expect(orchUsage.tokensIn).toBe(1_500_000)
    expect(orchUsage.cacheTokens).toBe(350_000)
    expect(orchUsage.tokensOut).toBe(150_000)
    expect(orchUsage.estimatedCostUsd).toBeCloseTo(0.1386 + 0.07224, 5)
    expect(orchUsage.costStatus).toBe("estimated")
    expect(orchUsage.estimate).toBe(true)
  })

  it("preserves backward-compatibility with Claude Code events (where promptTokensIncludesCache is absent)", () => {
    const log = new EventLog(":memory:")
    const task = log.createTask({ request: "claude task", sourceRoot: "/src", model: "claude-3-7-sonnet" })

    log.append({
      taskId: task.id,
      agent: "specialist",
      kind: "specialist.result",
      summary: "specialist answer",
      payload: {
        tokensIn: 1000,
        cacheTokens: 200,
        tokensOut: 300,
        costUsd: 0.4,
        estimate: true,
        costStatus: "estimated",
      },
    })

    const usage = log.usage(task.id)
    expect(usage[0]!.tokensIn).toBe(1200) // 1000 uncached + 200 cache = 1200 total
    expect(usage[0]!.cacheTokens).toBe(200)
    expect(usage[0]!.tokensOut).toBe(300)
  })

  it("correctly aggregates in frontend store without doubling cache", () => {
    const events: EventRow[] = [
      {
        id: 1,
        taskId: "t",
        stepId: null,
        agent: "orchestrator",
        at: 1,
        kind: "model.call",
        state: "",
        summary: "call 1",
        truncated: false,
        payload: {
          tokensIn: 1_000_000,
          cacheTokens: 250_000,
          tokensOut: 100_000,
          costUsd: 0.1386,
          costStatus: "estimated",
          estimate: true,
          promptTokensIncludesCache: true,
        },
      },
      {
        id: 2,
        taskId: "t",
        stepId: null,
        agent: "orchestrator",
        at: 2,
        kind: "model.call",
        state: "",
        summary: "call 2",
        truncated: false,
        payload: {
          tokensIn: 500_000,
          cacheTokens: 50_000,
          tokensOut: 50_000,
          costUsd: 0.078,
          costStatus: "estimated",
          estimate: true,
          promptTokensIncludesCache: true,
        },
      },
    ]

    const usage = usageByAgent(events)
    expect(usage).toHaveLength(1)
    expect(usage[0]!.tokensIn).toBe(1_500_000)
    expect(usage[0]!.cacheTokens).toBe(300_000)
    expect(usage[0]!.tokensOut).toBe(150_000)
    expect(usage[0]!.costUsd).toBeCloseTo(0.1386 + 0.078, 5)
    expect(usage[0]!.estimate).toBe(true)
  })
})
