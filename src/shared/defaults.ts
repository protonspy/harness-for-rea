import { PROVIDERS } from "./providers"
import type { Settings } from "./types"

export const DEFAULT_MODEL = PROVIDERS.openrouter.defaultModel
/** Offered beside the default and sent as the fallback in OpenRouter's `models` routing. */
export const PRESET_MODEL = "qwen/qwen3.7-flash"
export const MODEL_PRESETS = [DEFAULT_MODEL, PRESET_MODEL] as const
/** Both agents start on Hopper, on the host (specs/specialist-providers R1.4, adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent). */
export const HOPPER_MODEL = PROVIDERS.hopper.defaultModel

export const DEFAULT_SETTINGS: Settings = {
  provider: "hopper",
  baseUrl: "",
  baseUrls: {},
  model: HOPPER_MODEL,
  timeoutMinutes: 20,
  orchestratorEffort: "default",
  specialistEffort: "default",
  specialistProvider: "hopper",
  specialistModel: HOPPER_MODEL,
  approvalTimeoutMinutes: 30,
  questionTimeoutMinutes: 10,
  setupCompleted: false,
  integrations: {},
}
