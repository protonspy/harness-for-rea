import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"
import { AsyncEntry } from "@napi-rs/keyring"
import type { KeyStore } from "./credentials"
import { defaultDataDir, LOCKS_DIR } from "./lock"

/*
  The one key store both apps read (specs/shared-data-folder R5.1, adr:0024-share-the-data-folder-between-processes):
  each provider's key in the OS keychain — Credential Manager on Windows, the Keychain on macOS, the Secret Service on
  Linux — through `@napi-rs/keyring`, one generic credential per slot under one service, its secret the key's UTF-8
  bytes. It loads in Electron's Node and under Bun alike; a keychain it cannot reach fails the write, and no key is kept elsewhere.
*/

export const SERVICE = "harness-for-rea"
const CHUNK_PREFIX = "__HFR_CHUNKED__:"
const CHUNK_BYTE_LIMIT = 2000
const MAX_READ_RETRIES = 3

/** The part of `@napi-rs/keyring`'s `AsyncEntry` the store uses. */
export interface KeyEntry {
  getSecret(): Promise<number[] | null>
  setSecret(secret: Uint8Array): Promise<void>
  deleteCredential(): Promise<boolean>
}

type MakeEntry = (service: string, name: string) => KeyEntry

const keyring: MakeEntry = (s, n) => new AsyncEntry(s, n)

interface ChunkManifest {
  gen?: string
  count: number
}

function parseManifest(raw: string): ChunkManifest | null {
  if (!raw.startsWith(CHUNK_PREFIX)) return null
  const rest = raw.slice(CHUNK_PREFIX.length)
  const parts = rest.split(":")
  if (parts.length === 2) {
    return { gen: parts[0], count: parseInt(parts[1], 10) }
  }
  if (parts.length === 1) {
    return { count: parseInt(parts[0], 10) }
  }
  return null
}

function chunkSlotName(slot: string, gen: string | undefined, index: number): string {
  return gen ? `${slot}#${gen}#${index}` : `${slot}#${index}`
}

const slotTails = new Map<string, Promise<void>>()

function withInProcessQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = slotTails.get(key) ?? Promise.resolve()
  let resolveTask!: () => void
  const taskDone = new Promise<void>((r) => {
    resolveTask = r
  })
  slotTails.set(key, taskDone)

  return prev
    .catch(() => {})
    .then(async () => {
      try {
        return await task()
      } finally {
        resolveTask()
        if (slotTails.get(key) === taskDone) {
          slotTails.delete(key)
        }
      }
    })
}

async function acquireCrossProcessLock(dir: string | null | undefined, slot: string, timeoutMs = 5000): Promise<(() => void) | null> {
  if (!dir) return null
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  const safe = slot.replace(/[^a-zA-Z0-9_-]/g, "_")
  const file = join(dir, `keyring-${safe}.lock`)
  const me = JSON.stringify({ pid: process.pid, time: Date.now() })
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = openSync(file, "wx")
      writeSync(fd, me)
      closeSync(fd)
      return () => {
        try {
          rmSync(file, { force: true })
        } catch {}
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        const stat = statSync(file)
        if (Date.now() - stat.mtimeMs > 10_000) {
          rmSync(file, { force: true })
          continue
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  throw new Error(`Timed out waiting for keyring slot lock: ${slot}`)
}

async function withSlotCoordination<T>(dir: string | null | undefined, service: string, slot: string, fn: () => Promise<T>): Promise<T> {
  const queueKey = `${service}/${slot}`
  return withInProcessQueue(queueKey, async () => {
    const releaseFile = await acquireCrossProcessLock(dir, slot)
    try {
      return await fn()
    } finally {
      releaseFile?.()
    }
  })
}

export function keyringStore(service = SERVICE, make: MakeEntry | null = keyring, lockDir?: string | null): KeyStore {
  const resolvedLockDir = lockDir !== undefined ? lockDir : make === keyring ? join(defaultDataDir(), LOCKS_DIR) : null

  return {
    available: () => make !== null,
    read: async (slot) => {
      if (!make) return null

      for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
        const bytes = await make(service, slot).getSecret()
        if (!bytes || !bytes.length) return null
        const raw = Buffer.from(bytes).toString("utf8")
        const manifest = parseManifest(raw)
        if (!manifest) return raw

        const chunks: Uint8Array[] = []
        let totalLen = 0
        let missingChunk = false

        for (let i = 0; i < manifest.count; i++) {
          const chunkName = chunkSlotName(slot, manifest.gen, i)
          const chunkBytes = await make(service, chunkName).getSecret()
          if (!chunkBytes) {
            missingChunk = true
            break
          }
          const u8 = new Uint8Array(chunkBytes)
          chunks.push(u8)
          totalLen += u8.length
        }

        if (missingChunk) {
          const checkBytes = await make(service, slot).getSecret()
          if (!checkBytes || !checkBytes.length) return null
          const checkRaw = Buffer.from(checkBytes).toString("utf8")
          const checkManifest = parseManifest(checkRaw)
          if (!checkManifest) {
            return checkRaw
          }
          if (checkManifest.gen !== manifest.gen) {
            continue
          }
          return null
        }

        if (attempt < MAX_READ_RETRIES - 1) {
          const finalCheckBytes = await make(service, slot).getSecret()
          if (!finalCheckBytes || !finalCheckBytes.length) {
            return null
          }
          const finalRaw = Buffer.from(finalCheckBytes).toString("utf8")
          const finalManifest = parseManifest(finalRaw)
          if (!finalManifest) {
            return finalRaw
          }
          if (finalManifest.gen !== manifest.gen) {
            continue
          }
        }

        const combined = new Uint8Array(totalLen)
        let offset = 0
        for (const c of chunks) {
          combined.set(c, offset)
          offset += c.length
        }
        return new TextDecoder().decode(combined)
      }

      return null
    },
    write: async (slot, key) => {
      if (!make) throw new Error("The OS keychain is not available.")

      return withSlotCoordination(resolvedLockDir, service, slot, async () => {
        const entry = make(service, slot)

        // Handle deletion
        if (key === null) {
          const existing = await entry.getSecret().catch(() => null)
          if (existing) {
            const manifest = parseManifest(Buffer.from(existing).toString("utf8"))
            if (manifest) {
              for (let i = 0; i < manifest.count; i++) {
                await make(service, chunkSlotName(slot, manifest.gen, i))
                  .deleteCredential()
                  .catch(() => false)
              }
            }
          }
          await entry.deleteCredential().catch(() => false)
          return
        }

        // Encode UTF-8 bytes once
        const allBytes = new TextEncoder().encode(key)
        const existing = await entry.getSecret().catch(() => null)
        const oldManifest = existing ? parseManifest(Buffer.from(existing).toString("utf8")) : null

        if (allBytes.byteLength > CHUNK_BYTE_LIMIT) {
          const chunks: Uint8Array[] = []
          for (let i = 0; i < allBytes.byteLength; i += CHUNK_BYTE_LIMIT) {
            chunks.push(allBytes.subarray(i, i + CHUNK_BYTE_LIMIT))
          }

          const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
          const written: number[] = []

          try {
            for (let i = 0; i < chunks.length; i++) {
              await make(service, chunkSlotName(slot, gen, i)).setSecret(chunks[i])
              written.push(i)
            }

            // Atomically publish new manifest to root slot
            const manifestStr = `${CHUNK_PREFIX}${gen}:${chunks.length}`
            await entry.setSecret(new TextEncoder().encode(manifestStr))
          } catch (err) {
            // Rollback newly written chunks on failure; preserve existing slot and prior chunks
            for (const i of written) {
              await make(service, chunkSlotName(slot, gen, i))
                .deleteCredential()
                .catch(() => false)
            }
            throw err
          }

          // Clean up prior generation chunks after successful commit
          if (oldManifest) {
            for (let i = 0; i < oldManifest.count; i++) {
              await make(service, chunkSlotName(slot, oldManifest.gen, i))
                .deleteCredential()
                .catch(() => false)
            }
          }
        } else {
          await entry.setSecret(allBytes)

          // Clean up prior chunks if reducing from chunked to single entry
          if (oldManifest) {
            for (let i = 0; i < oldManifest.count; i++) {
              await make(service, chunkSlotName(slot, oldManifest.gen, i))
                .deleteCredential()
                .catch(() => false)
            }
          }
        }
      })
    },
  }
}
