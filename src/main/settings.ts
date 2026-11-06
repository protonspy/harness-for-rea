import { DEFAULT_SETTINGS } from "@shared/defaults"
import type { ProviderId } from "@shared/providers"
import type { Settings } from "@shared/types"
import { getSetting, setSetting } from "./db"

/*
  The user's settings, stored as one record over the defaults. Arguments are validated at the IPC boundary. Each
  provider keeps its own base URL (specs/orchestrator R1.10): `baseUrl` is the chosen provider's, and switching
  provider brings back the one it had. Each provider also preserves its configured protocol.
*/

const KEY = "app.settings"

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY, {})
  const s = { ...DEFAULT_SETTINGS, ...stored }
  // Settings saved before base URLs were kept per provider hold only the one of the provider they were on.
  const baseUrls = stored.baseUrls ?? (s.baseUrl ? { [s.provider]: s.baseUrl } : {})
  const protocols = {
    ...DEFAULT_SETTINGS.protocols,
    ...(stored.protocols ?? {}),
  }
  const orchestratorProtocol = s.orchestratorProtocol ?? protocols[s.provider] ?? "chat_completions"
  const specialistProtocol =
    s.specialistProtocol ?? (s.specialistProvider !== "claude" ? protocols[s.specialistProvider as ProviderId] : undefined) ?? "chat_completions"
  return { ...s, baseUrls, baseUrl: baseUrls[s.provider] ?? "", protocols, orchestratorProtocol, specialistProtocol }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const provider = patch.provider ?? current.provider
  const specialistProvider = patch.specialistProvider ?? current.specialistProvider
  const baseUrls = { ...current.baseUrls, ...(patch.baseUrl !== undefined ? { [provider]: patch.baseUrl } : {}) }
  const protocols = {
    ...current.protocols,
    ...(patch.protocols ?? {}),
    ...(patch.orchestratorProtocol !== undefined ? { [provider]: patch.orchestratorProtocol } : {}),
    ...(patch.specialistProtocol !== undefined && specialistProvider !== "claude" ? { [specialistProvider as ProviderId]: patch.specialistProtocol } : {}),
  }
  const next: Settings = {
    ...current,
    ...patch,
    baseUrls,
    baseUrl: baseUrls[provider] ?? "",
    protocols,
    orchestratorProtocol: patch.orchestratorProtocol ?? protocols[provider] ?? current.orchestratorProtocol ?? "chat_completions",
    specialistProtocol:
      patch.specialistProtocol ??
      (specialistProvider !== "claude" ? protocols[specialistProvider as ProviderId] : undefined) ??
      current.specialistProtocol ??
      "chat_completions",
  }
  setSetting(KEY, next)
  return next
}
