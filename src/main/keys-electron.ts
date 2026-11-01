import { safeStorage } from "electron"
import type { KeyStore } from "./credentials"
import { getSetting, setSetting } from "./db"

/* The desktop app's key store: each key encrypted with `safeStorage` (the OS keychain; DPAPI on Windows), kept in the database. */

export function electronKeyStore(): KeyStore {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    read: async (slot) => {
      const v = getSetting<string | null>(slot, null)
      return v ? safeStorage.decryptString(Buffer.from(v, "base64")) : null
    },
    write: async (slot, key) => setSetting(slot, key === null ? null : safeStorage.encryptString(key).toString("base64")),
  }
}
