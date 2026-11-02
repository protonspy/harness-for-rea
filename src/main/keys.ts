import { AsyncEntry } from "@napi-rs/keyring"
import type { KeyStore } from "./credentials"

/*
  The one key store both apps read (specs/shared-data-folder R5.1, adr:0024-share-the-data-folder-between-processes):
  each provider's key in the OS keychain — Credential Manager on Windows, the Keychain on macOS, the Secret Service on
  Linux — through `@napi-rs/keyring`, one generic credential per slot under one service, its secret the key's UTF-8
  bytes. It loads in Electron's Node and under Bun alike; a keychain it cannot reach fails the write, and no key is kept elsewhere.
*/

export const SERVICE = "harness-for-rea"

/** The part of `@napi-rs/keyring`'s `AsyncEntry` the store uses. */
export interface KeyEntry {
  getSecret(): Promise<number[] | null>
  setSecret(secret: Uint8Array): Promise<void>
  deleteCredential(): Promise<boolean>
}

type MakeEntry = (service: string, name: string) => KeyEntry

const keyring: MakeEntry = (s, n) => new AsyncEntry(s, n)

export function keyringStore(service = SERVICE, make: MakeEntry | null = keyring): KeyStore {
  return {
    available: () => make !== null,
    read: async (slot) => {
      if (!make) return null
      const bytes = await make(service, slot).getSecret()
      return bytes && bytes.length ? Buffer.from(bytes).toString("utf8") : null
    },
    write: async (slot, key) => {
      if (!make) throw new Error("The OS keychain is not available.")
      const entry = make(service, slot)
      if (key === null) await entry.deleteCredential().catch(() => false)
      else await entry.setSecret(new TextEncoder().encode(key))
    },
  }
}
