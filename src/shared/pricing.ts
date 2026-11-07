import type { ProviderId } from "./providers"

/*
  Model pricing catalog and cost estimation (specs/river-pricing, issue #6).
  Rates are in USD per 1,000,000 (1M) tokens.
  Reference snapshot captured from River Console on 2026-11-04.
*/

export interface ModelRate {
  input: number
  cached: number
  output: number
}

export interface ModelPricingEntry {
  currency: "USD"
  unit: "USD / 1M tokens"
  origin: string
  referenceDate: string
  rates: ModelRate
}

export interface ModelRateSnapshot {
  currency: "USD"
  unit: "USD / 1M tokens"
  origin: string
  referenceDate: string
  inputRate: number
  cacheRate: number
  outputRate: number
}

export type CostStatus = "reported" | "estimated" | "unknown"
export type CacheHypothesis = "exact" | "assumed_zero_cache"

export interface CostEstimateResult {
  costUsd: number
  cacheHypothesis: CacheHypothesis
  rateSnapshot: ModelRateSnapshot
}

export const RIVER_PRICING_METADATA = {
  currency: "USD" as const,
  unit: "USD / 1M tokens" as const,
  origin: "River Console reference capture",
  referenceDate: "2026-11-04",
}

export const RIVER_MODEL_PRICING: Record<string, ModelPricingEntry> = {
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 0.12, cached: 0.0024, output: 0.48 },
  },
  "GLM-5.3": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 1.12, cached: 0.208, output: 3.52 },
  },
  "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 0.07, cached: 0.024, output: 0.37 },
  },
  "zai-org/GLM-5.3-Flash": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 0.12, cached: 0.024, output: 0.4 },
  },
  "Qwen/Qwen3.8-27B-FP8": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 0.1, cached: 0.02, output: 2.0 },
  },
  "deepseek-ai/DeepSeek-V4.1-Flash": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 0.12, cached: 0.0024, output: 0.48 },
  },
  "moonshotai/Kimi-K3": {
    ...RIVER_PRICING_METADATA,
    rates: { input: 3.0, cached: 0.3, output: 15.0 },
  },
}

/** Matches a model against River's pricing catalog (case-insensitive, optional org prefix). */
export function getRiverModelPricing(model: string): ModelPricingEntry | undefined {
  if (!model) return undefined
  if (RIVER_MODEL_PRICING[model]) return RIVER_MODEL_PRICING[model]
  const lower = model.toLowerCase().trim()
  for (const [key, entry] of Object.entries(RIVER_MODEL_PRICING)) {
    if (key.toLowerCase() === lower) return entry
    const keyWithoutOrg = key.includes("/") ? key.split("/")[1]!.toLowerCase() : key.toLowerCase()
    if (keyWithoutOrg === lower) return entry
  }
  return undefined
}

/** Returns the pricing catalog entry for a provider and model, if known. */
export function getModelPricing(provider: ProviderId | string, model: string): ModelPricingEntry | undefined {
  if (provider === "river") {
    return getRiverModelPricing(model)
  }
  return undefined
}

/**
 * Calculates estimated USD cost using the formula:
 * USD = ((entrada_total - entrada_cache) * preço_entrada + entrada_cache * preço_cache + saída_total * preço_saída) / 1_000_000
 *
 * Output tokens already include reasoning tokens in completion_tokens / output_tokens; they are not added again.
 * If cache detail is absent, cache is assumed 0 without inventing a measurement, and documented in cacheHypothesis.
 */
export function estimateCostUsd(
  tokensInTotal: number,
  cacheTokens: number | undefined,
  tokensOutTotal: number,
  pricing: ModelPricingEntry,
): CostEstimateResult {
  const hasCacheDetail = typeof cacheTokens === "number" && !isNaN(cacheTokens)
  const actualCache = hasCacheDetail ? Math.min(Math.max(0, cacheTokens), Math.max(0, tokensInTotal)) : 0
  const uncachedIn = Math.max(0, tokensInTotal - actualCache)

  const inCost = uncachedIn * pricing.rates.input
  const cacheCost = actualCache * pricing.rates.cached
  const outCost = Math.max(0, tokensOutTotal) * pricing.rates.output

  const costRaw = (inCost + cacheCost + outCost) / 1_000_000
  // Round to 8 decimal places to avoid floating point artifacts
  const costUsd = Math.round(costRaw * 1e8) / 1e8

  return {
    costUsd,
    cacheHypothesis: hasCacheDetail ? "exact" : "assumed_zero_cache",
    rateSnapshot: {
      currency: pricing.currency,
      unit: pricing.unit,
      origin: pricing.origin,
      referenceDate: pricing.referenceDate,
      inputRate: pricing.rates.input,
      cacheRate: pricing.rates.cached,
      outputRate: pricing.rates.output,
    },
  }
}

/** Short pricing summary for model dropdowns, e.g. "($0.12/$0.0024/$0.48 per 1M)" */
export function formatModelPricingShort(pricing: ModelPricingEntry): string {
  const r = pricing.rates
  return `($${r.input}/$${r.cached}/$${r.output} per 1M)`
}

/** Detailed pricing descriptor with currency, unit, origin and date */
export function formatModelPricingDetails(pricing: ModelPricingEntry): string {
  const r = pricing.rates
  return `${pricing.currency} per 1M tokens: In $${r.input} · Cache $${r.cached} · Out $${r.output} (${pricing.origin}, ${pricing.referenceDate})`
}
