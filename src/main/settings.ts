import { DEFAULT_SETTINGS } from "@shared/defaults"
import type { Settings } from "@shared/types"
import { getSetting, setSetting } from "./db"

/*
  The user's settings, stored as one record over the defaults. Arguments are validated at the IPC boundary. Each
  provider keeps its own base URL (specs/orchestrator R1.10): `baseUrl` is the chosen provider's, and switching
  provider brings back the one it had.
*/

const KEY = "app.settings"

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY, {})
  const s = { ...DEFAULT_SETTINGS, ...stored }
  // Settings saved before base URLs were kept per provider hold only the one of the provider they were on.
  const baseUrls = stored.baseUrls ?? (s.baseUrl ? { [s.provider]: s.baseUrl } : {})
  return { ...s, baseUrls, baseUrl: baseUrls[s.provider] ?? "" }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const provider = patch.provider ?? current.provider
  const baseUrls = { ...current.baseUrls, ...(patch.baseUrl !== undefined ? { [provider]: patch.baseUrl } : {}) }
  const next = { ...current, ...patch, baseUrls, baseUrl: baseUrls[provider] ?? "" }
  setSetting(KEY, next)
  return next
}
