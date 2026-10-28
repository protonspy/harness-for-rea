import type { Settings } from "./types"

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017"
/** Offered beside the default and sent as the fallback in OpenRouter's `models` routing. */
export const PRESET_MODEL = "z-ai/glm-5.3-flash"
export const MODEL_PRESETS = [DEFAULT_MODEL, PRESET_MODEL] as const

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  timeoutMinutes: 20,
  memoryMb: 2048,
  cpus: 2,
  pidsLimit: 256,
  discardOnCompletion: true,
}
