import { PROVIDERS } from "./providers"
import type { Settings } from "./types"

export const DEFAULT_MODEL = PROVIDERS.openrouter.defaultModel
/** Offered beside the default and sent as the fallback in OpenRouter's `models` routing. */
export const PRESET_MODEL = "z-ai/glm-5.3-flash"
export const MODEL_PRESETS = [DEFAULT_MODEL, PRESET_MODEL] as const

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  baseUrl: "",
  model: DEFAULT_MODEL,
  timeoutMinutes: 20,
  orchestratorEffort: "default",
  specialistEffort: "default",
  approvalTimeoutMinutes: 30,
  questionTimeoutMinutes: 10,
  setupCompleted: false,
}
