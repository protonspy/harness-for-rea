import { safeStorage } from "electron"
import { PROVIDER_IDS, type ProviderId } from "@shared/providers"
import type { KeyStatus } from "@shared/types"
import { getSetting, setSetting } from "./db"

/*
  One API key per orchestrator provider, encrypted with the OS keychain through `safeStorage` (DPAPI
  on Windows). With encryption unavailable the key is refused, never stored in plain text. The renderer
  only ever learns whether a key is set and a masked hint. OpenRouter's key keeps the slot it always had.
*/

const slot = (provider: ProviderId) => (provider === "openrouter" ? "openrouter.key" : `${provider}.key`)

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

const cached = new Map<ProviderId, string>()
const listeners = new Set<(key: string) => void>()

/** Called with every key whenever one is loaded or saved, so the redactor can register it. */
export function onKey(fn: (key: string) => void) {
  listeners.add(fn)
  for (const key of cached.values()) fn(key)
}

function loaded(provider: ProviderId, key: string) {
  cached.set(provider, key)
  for (const fn of listeners) fn(key)
}

/** Decrypt the stored keys once; afterwards `readKey` is a synchronous read. */
export function initKey() {
  cached.clear()
  if (!safeStorage.isEncryptionAvailable()) return
  for (const provider of PROVIDER_IDS) {
    const v = getSetting<string | null>(slot(provider), null)
    if (!v) continue
    try {
      loaded(provider, safeStorage.decryptString(Buffer.from(v, "base64")))
    } catch {
      cached.delete(provider)
    }
  }
}

export function saveKey(key: string, provider: ProviderId = "openrouter"): KeyStatus {
  const trimmed = key.trim()
  if (!safeStorage.isEncryptionAvailable())
    throw new CredentialError("The OS keychain is not available, so the key was not stored. Harness for REA never keeps it in plain text.")
  setSetting(slot(provider), safeStorage.encryptString(trimmed).toString("base64"))
  loaded(provider, trimmed)
  return keyStatus(provider)
}

export function clearKey(provider: ProviderId = "openrouter"): KeyStatus {
  setSetting(slot(provider), null)
  cached.delete(provider)
  return keyStatus(provider)
}

export function readKey(provider: ProviderId = "openrouter"): string | null {
  return cached.get(provider) ?? null
}

export function keyStatus(provider: ProviderId = "openrouter"): KeyStatus {
  const k = cached.get(provider)
  return { set: !!k, hint: k ? `…${k.slice(-4)}` : "", encryption: safeStorage.isEncryptionAvailable() }
}
