import { safeStorage } from "electron"
import type { KeyStatus } from "@shared/types"
import { getSetting, setSetting } from "./db"

/*
  The OpenRouter key, encrypted with the OS keychain through `safeStorage` (DPAPI on Windows).
  With encryption unavailable the key is refused, never stored in plain text. The renderer only
  ever learns whether a key is set and a masked hint.
*/

const KEY = "openrouter.key"

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

let cached: string | null = null
const listeners = new Set<(key: string) => void>()

/** Called with the key whenever it is loaded or saved, so the redactor can register it. */
export function onKey(fn: (key: string) => void) {
  listeners.add(fn)
  if (cached) fn(cached)
}

function loaded(key: string) {
  cached = key
  for (const fn of listeners) fn(key)
}

/** Decrypt the stored key once; afterwards `readKey` is a synchronous read. */
export function initKey() {
  cached = null
  const v = getSetting<string | null>(KEY, null)
  if (!v || !safeStorage.isEncryptionAvailable()) return
  try {
    loaded(safeStorage.decryptString(Buffer.from(v, "base64")))
  } catch {
    cached = null
  }
}

export function saveKey(key: string): KeyStatus {
  const trimmed = key.trim()
  if (!safeStorage.isEncryptionAvailable())
    throw new CredentialError("The OS keychain is not available, so the key was not stored. Harness for REA never keeps it in plain text.")
  setSetting(KEY, safeStorage.encryptString(trimmed).toString("base64"))
  loaded(trimmed)
  return keyStatus()
}

export function clearKey(): KeyStatus {
  setSetting(KEY, null)
  cached = null
  return keyStatus()
}

export function readKey(): string | null {
  return cached
}

export function keyStatus(): KeyStatus {
  const k = cached
  return { set: !!k, hint: k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "", encryption: safeStorage.isEncryptionAvailable() }
}
