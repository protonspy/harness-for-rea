import { ChatOpenRouter } from "@langchain/openrouter"
import { PRESET_MODEL } from "@shared/defaults"

/*
  The orchestrator's chat model (specs/orchestrator R1): any OpenRouter model the user picked, with
  the preset as the fallback in OpenRouter's `models` routing, provider data collection denied since
  source code is sent, and each call's usage and cost handed to `onUsage`.
*/

export interface ModelUsage {
  tokensIn: number
  tokensOut: number
  /** OpenRouter's `usage.cost`, in USD; 0 when it did not report one */
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

export function makeModel(o: { apiKey: string; model: string; onUsage(u: ModelUsage): void }): ChatOpenRouter {
  return new ChatOpenRouter({
    model: o.model,
    apiKey: o.apiKey,
    models: fallbackModels(o.model),
    provider: { data_collection: "deny" },
    temperature: 0.2,
    siteUrl: "https://github.com/protonspy/harness-for-rea",
    siteName: "Harness for REA",
    callbacks: [
      {
        handleLLMEnd(output) {
          o.onUsage(usageOf(output as LlmEndOutput, o.model))
        },
      },
    ],
  })
}
