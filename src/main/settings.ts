import { DEFAULT_SETTINGS } from "@shared/defaults"
import { PROVIDERS, type ModelProtocol, type ProviderId } from "@shared/providers"
import type { Settings } from "@shared/types"
import { getSetting, setSetting } from "./db"

/*
  The user's settings, stored as one record over the defaults. Arguments are validated at the IPC boundary. Each
  provider keeps its own base URL (specs/orchestrator R1.10): `baseUrl` is the chosen provider's, and switching
  provider brings back the one it had. Each provider and role also preserves its configured protocol independently.
*/

const KEY = "app.settings"

export function getSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY, {})
  const s = { ...DEFAULT_SETTINGS, ...stored }
  // Settings saved before base URLs were kept per provider hold only the one of the provider they were on.
  const baseUrls = stored.baseUrls ?? (s.baseUrl ? { [s.provider]: s.baseUrl } : {})

  const orchestratorProtocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...DEFAULT_SETTINGS.orchestratorProtocols,
    ...(stored.orchestratorProtocols ?? {}),
  }
  const specialistProtocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...DEFAULT_SETTINGS.specialistProtocols,
    ...(stored.specialistProtocols ?? {}),
  }
  const protocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...DEFAULT_SETTINGS.protocols,
    ...(stored.protocols ?? {}),
    ...orchestratorProtocols,
  }

  const orchestratorProtocol =
    orchestratorProtocols[s.provider] ??
    stored.orchestratorProtocol ??
    stored.protocols?.[s.provider] ??
    PROVIDERS[s.provider]?.defaultProtocol ??
    "chat_completions"

  const specialistProtocol =
    (s.specialistProvider !== "claude" ? specialistProtocols[s.specialistProvider as ProviderId] : undefined) ??
    stored.specialistProtocol ??
    (s.specialistProvider !== "claude" ? stored.protocols?.[s.specialistProvider as ProviderId] : undefined) ??
    (s.specialistProvider !== "claude" ? PROVIDERS[s.specialistProvider as ProviderId]?.defaultProtocol : undefined) ??
    "chat_completions"

  return {
    ...s,
    baseUrls,
    baseUrl: baseUrls[s.provider] ?? "",
    specialistBaseUrl: s.specialistProvider !== "claude" ? (baseUrls[s.specialistProvider as ProviderId] ?? "") : undefined,
    orchestratorProtocols,
    specialistProtocols,
    protocols,
    orchestratorProtocol,
    specialistProtocol,
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const provider = patch.provider ?? current.provider
  const specialistProvider = patch.specialistProvider ?? current.specialistProvider
  const baseUrls = {
    ...current.baseUrls,
    ...(patch.baseUrl !== undefined ? { [provider]: patch.baseUrl } : {}),
    ...(patch.specialistBaseUrl !== undefined && specialistProvider !== "claude"
      ? { [specialistProvider as ProviderId]: patch.specialistBaseUrl }
      : {}),
  }

  const orchestratorProtocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...current.orchestratorProtocols,
    ...(patch.orchestratorProtocols ?? {}),
    ...(patch.orchestratorProtocol !== undefined ? { [provider]: patch.orchestratorProtocol } : {}),
  }

  const specialistProtocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...current.specialistProtocols,
    ...(patch.specialistProtocols ?? {}),
    ...(patch.specialistProtocol !== undefined && specialistProvider !== "claude" ? { [specialistProvider as ProviderId]: patch.specialistProtocol } : {}),
  }

  const orchestratorProtocol =
    patch.orchestratorProtocol ??
    (patch.provider && patch.provider !== current.provider
      ? (orchestratorProtocols[patch.provider] ?? PROVIDERS[patch.provider]?.defaultProtocol ?? "chat_completions")
      : (current.orchestratorProtocol ?? orchestratorProtocols[provider] ?? "chat_completions"))

  const specialistProtocol =
    patch.specialistProtocol ??
    (patch.specialistProvider && patch.specialistProvider !== current.specialistProvider && patch.specialistProvider !== "claude"
      ? (specialistProtocols[patch.specialistProvider as ProviderId] ??
        PROVIDERS[patch.specialistProvider as ProviderId]?.defaultProtocol ??
        "chat_completions")
      : (current.specialistProtocol ??
        (specialistProvider !== "claude" ? specialistProtocols[specialistProvider as ProviderId] : undefined) ??
        "chat_completions"))

  const protocols: Partial<Record<ProviderId, ModelProtocol>> = {
    ...current.protocols,
    ...(patch.protocols ?? {}),
    ...orchestratorProtocols,
  }

  const next: Settings = {
    ...current,
    ...patch,
    provider,
    specialistProvider,
    baseUrls,
    baseUrl: baseUrls[provider] ?? "",
    specialistBaseUrl: specialistProvider !== "claude" ? (baseUrls[specialistProvider as ProviderId] ?? "") : undefined,
    orchestratorProtocols,
    specialistProtocols,
    protocols,
    orchestratorProtocol,
    specialistProtocol,
  }
  setSetting(KEY, next)
  return next
}
