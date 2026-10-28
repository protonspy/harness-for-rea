import { DEFAULT_SETTINGS } from "@shared/defaults"
import type { Settings } from "@shared/types"
import { getSetting, setSetting } from "./db"

/* The user's settings, stored as one record over the defaults. Arguments are validated at the IPC boundary. */

const KEY = "app.settings"

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...getSetting<Partial<Settings>>(KEY, {}) }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  setSetting(KEY, next)
  return next
}
