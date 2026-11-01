import type { KeyStore } from "../../src/main/credentials"

/*
  The TUI's key store (specs/tui R1.3): each provider's key in the OS keychain itself — Credential Manager on
  Windows, the Keychain on macOS, libsecret on Linux — through `Bun.secrets`, one entry per slot under one service.
  Nothing of it is written to the data folder.
*/

export const SERVICE = "harness-for-rea"

export function keychainKeyStore(service = SERVICE): KeyStore {
  return {
    available: () => typeof Bun !== "undefined" && typeof Bun.secrets?.get === "function",
    read: async (slot) => (await Bun.secrets.get({ service, name: slot })) ?? null,
    write: async (slot, key) => {
      if (key === null) await Bun.secrets.delete({ service, name: slot })
      else await Bun.secrets.set({ service, name: slot, value: key })
    },
  }
}
