import { safeStorage } from "electron"
import type { KeyStore } from "./credentials"
import { getSetting, setSetting } from "./db"

/*
  Where the desktop app kept keys before the shared keychain (specs/shared-data-folder R5.2): each encrypted with
  `safeStorage` into the database. Read once at start, moved into the shared store and removed from here.
*/

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
