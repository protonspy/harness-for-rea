import { PROVIDER_IDS, type ProviderId } from "@shared/providers"
import type { KeyStatus } from "@shared/types"

/*
  One API key per orchestrator provider, kept by the host's key store: the desktop app's encrypts it with the OS
  keychain through `safeStorage` (DPAPI on Windows), the TUI's keeps it in the OS keychain itself. With the store
  unavailable the key is refused, never stored in plain text. The renderer only ever learns whether a key is set
  and a masked hint. OpenRouter's key keeps the slot it always had.
*/

/** Where a host keeps the keys (plans/finish-the-harness 1.8): read and written whole, by slot. */
export interface KeyStore {
  /** whether keys can be kept protected by the OS; when not, none is stored */
  available(): boolean | Promise<boolean>
  read(slot: string): Promise<string | null>
  /** `null` removes the slot */
  write(slot: string, key: string | null): Promise<void>
}

const slot = (provider: ProviderId) => (provider === "openrouter" ? "openrouter.key" : `${provider}.key`)

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

let store: KeyStore | null = null
let encryptionAvailable = false
let pendingAvailability: Promise<boolean> | null = null
const cached = new Map<ProviderId, string>()
const listeners = new Set<(key: string) => void>()

/** Explicitly refresh and return whether the key store's encryption is available. */
export async function refreshKeyAvailability(): Promise<boolean> {
  if (!store) {
    encryptionAvailable = false
    return false
  }
  if (pendingAvailability) return pendingAvailability

  const currentStore = store
  let probe: boolean | Promise<boolean>
  try {
    probe = currentStore.available()
  } catch {
    if (store === currentStore) encryptionAvailable = false
    return false
  }

  if (typeof probe === "boolean") {
    encryptionAvailable = probe
    return probe
  }

  pendingAvailability = Promise.resolve(probe)
    .then((result) => {
      if (store === currentStore) {
        encryptionAvailable = Boolean(result)
      }
      return encryptionAvailable
    })
    .catch(() => {
      if (store === currentStore) {
        encryptionAvailable = false
      }
      return false
    })
    .finally(() => {
      pendingAvailability = null
    })

  return pendingAvailability
}

/** The host's key store, set once at start before `initKey`. */
export function useKeyStore(s: KeyStore) {
  store = s
  pendingAvailability = null
  let probe: boolean | Promise<boolean>
  try {
    probe = s.available()
  } catch {
    encryptionAvailable = false
    return
  }

  if (typeof probe === "boolean") {
    encryptionAvailable = probe
  } else {
    encryptionAvailable = false
    void Promise.resolve(probe)
      .then((v) => {
        if (store === s) encryptionAvailable = Boolean(v)
      })
      .catch(() => {
        if (store === s) encryptionAvailable = false
      })
  }
}

function keys(): KeyStore {
  if (!store) throw new CredentialError("No key store is set.")
  return store
}

/** Called with every key whenever one is loaded or saved, so the redactor can register it. */
export function onKey(fn: (key: string) => void) {
  listeners.add(fn)
  for (const key of cached.values()) fn(key)
}

function loaded(provider: ProviderId, key: string) {
  cached.set(provider, key)
  for (const fn of listeners) fn(key)
}

/**
  Move the keys a host kept in its former store into the shared one, and remove them from the former store
  (specs/shared-data-folder R5.2). A key already in the shared store wins. Returns how many were moved.
*/
export async function moveKeys(from: KeyStore, to: KeyStore): Promise<number> {
  const [fromAvail, toAvail] = await Promise.all([
    Promise.resolve()
      .then(() => from.available())
      .catch(() => false),
    Promise.resolve()
      .then(() => to.available())
      .catch(() => false),
  ])
  if (!fromAvail || !toAvail) return 0
  let moved = 0
  for (const provider of PROVIDER_IDS) {
    const name = slot(provider)
    try {
      const old = await from.read(name)
      if (!old) continue
      if (!(await to.read(name))) await to.write(name, old)
      await from.write(name, null)
      moved++
    } catch {
      // Left where it was, to be moved at the next start.
    }
  }
  return moved
}

/** Read the stored keys once; afterwards `readKey` is a synchronous read. A key that cannot be read is left unset. */
export async function initKey(): Promise<void> {
  cached.clear()
  const avail = await refreshKeyAvailability()
  if (!avail) return
  for (const provider of PROVIDER_IDS) {
    try {
      const v = await keys().read(slot(provider))
      if (v) loaded(provider, v)
    } catch {
      cached.delete(provider)
    }
  }
}

export async function saveKey(key: string, provider: ProviderId = "openrouter"): Promise<KeyStatus> {
  const trimmed = key.trim()
  const avail = await refreshKeyAvailability()
  if (!avail) throw new CredentialError("The OS keychain is not available, so the key was not stored. Harness for REA never keeps it in plain text.")
  await keys().write(slot(provider), trimmed)
  loaded(provider, trimmed)
  return keyStatus(provider)
}

export async function clearKey(provider: ProviderId = "openrouter"): Promise<KeyStatus> {
  await refreshKeyAvailability()
  await keys().write(slot(provider), null)
  cached.delete(provider)
  return keyStatus(provider)
}

export function readKey(provider: ProviderId = "openrouter"): string | null {
  return cached.get(provider) ?? null
}

export function keyStatus(provider: ProviderId = "openrouter"): KeyStatus {
  const k = cached.get(provider)
  return { set: !!k, hint: k ? `…${k.slice(-4)}` : "", encryption: encryptionAvailable }
}
