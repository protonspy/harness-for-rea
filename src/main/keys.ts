import { AsyncEntry } from "@napi-rs/keyring"
import type { KeyStore } from "./credentials"

/*
  The one key store both apps read (specs/shared-data-folder R5.1, adr:0024-share-the-data-folder-between-processes):
  each provider's key in the OS keychain — Credential Manager on Windows, the Keychain on macOS, the Secret Service on
  Linux — through `@napi-rs/keyring`, one generic credential per slot under one service, its secret the key's UTF-8
  bytes. It loads in Electron's Node and under Bun alike; a keychain it cannot reach fails the write, and no key is kept elsewhere.
*/

export const SERVICE = "harness-for-rea"
const CHUNK_PREFIX = "__HFR_CHUNKED__:"
const CHUNK_SIZE = 2000

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
      if (!bytes || !bytes.length) return null
      const raw = Buffer.from(bytes).toString("utf8")
      if (raw.startsWith(CHUNK_PREFIX)) {
        const count = parseInt(raw.slice(CHUNK_PREFIX.length), 10)
        let full = ""
        for (let i = 0; i < count; i++) {
          const chunkBytes = await make(service, `${slot}#${i}`).getSecret()
          if (!chunkBytes) return null
          full += Buffer.from(chunkBytes).toString("utf8")
        }
        return full
      }
      return raw
    },
    write: async (slot, key) => {
      if (!make) throw new Error("The OS keychain is not available.")
      const entry = make(service, slot)
      if (key === null) {
        const existing = await entry.getSecret().catch(() => null)
        if (existing) {
          const raw = Buffer.from(existing).toString("utf8")
          if (raw.startsWith(CHUNK_PREFIX)) {
            const count = parseInt(raw.slice(CHUNK_PREFIX.length), 10)
            for (let i = 0; i < count; i++) {
              await make(service, `${slot}#${i}`)
                .deleteCredential()
                .catch(() => false)
            }
          }
        }
        await entry.deleteCredential().catch(() => false)
        return
      }

      if (key.length > CHUNK_SIZE) {
        const chunks: string[] = []
        for (let i = 0; i < key.length; i += CHUNK_SIZE) {
          chunks.push(key.slice(i, i + CHUNK_SIZE))
        }
        for (let i = 0; i < chunks.length; i++) {
          await make(service, `${slot}#${i}`).setSecret(new TextEncoder().encode(chunks[i]))
        }
        await entry.setSecret(new TextEncoder().encode(`${CHUNK_PREFIX}${chunks.length}`))
      } else {
        const existing = await entry.getSecret().catch(() => null)
        if (existing) {
          const raw = Buffer.from(existing).toString("utf8")
          if (raw.startsWith(CHUNK_PREFIX)) {
            const count = parseInt(raw.slice(CHUNK_PREFIX.length), 10)
            for (let i = 0; i < count; i++) {
              await make(service, `${slot}#${i}`)
                .deleteCredential()
                .catch(() => false)
            }
          }
        }
        await entry.setSecret(new TextEncoder().encode(key))
      }
    },
  }
}
