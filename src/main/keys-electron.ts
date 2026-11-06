import { safeStorage } from "electron"
import type { KeyStore } from "./credentials"
import { getSetting, setSetting } from "./db"

/*
  Where the desktop app kept keys before the shared keychain (specs/shared-data-folder R5.2): each encrypted with
  `safeStorage` into the database. Read once at start, moved into the shared store and removed from here.
*/

export function electronKeyStore(): KeyStore {
  return {
    available: () =>
      typeof safeStorage.isAsyncEncryptionAvailable === "function" ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable(),
    read: async (slot) => {
      const v = getSetting<string | null>(slot, null)
      if (!v) return null
      const buf = Buffer.from(v, "base64")
      if (typeof safeStorage.decryptStringAsync === "function") {
        const decrypted = await safeStorage.decryptStringAsync(buf)
        return typeof decrypted === "string" ? decrypted : decrypted.result
      }
      return safeStorage.decryptString(buf)
    },
    write: async (slot, key) => {
      if (key === null) {
        setSetting(slot, null)
        return
      }
      const enc = typeof safeStorage.encryptStringAsync === "function" ? await safeStorage.encryptStringAsync(key) : safeStorage.encryptString(key)
      setSetting(slot, enc.toString("base64"))
    },
  }
}
