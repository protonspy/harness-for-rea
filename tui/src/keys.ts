import type { KeyStore } from "../../src/main/credentials"

/*
  Where the 0.1 TUI kept keys before the shared keychain (specs/shared-data-folder R5.2): `Bun.secrets`, one entry per
  slot under one service. Read once at start, moved into the shared store and removed from here.
*/

export const SERVICE = "harness-for-rea"

export function bunSecretsKeyStore(service = SERVICE): KeyStore {
  return {
    available: () => typeof Bun !== "undefined" && typeof Bun.secrets?.get === "function",
    read: async (slot) => (await Bun.secrets.get({ service, name: slot })) ?? null,
    write: async (slot, key) => {
      if (key === null) await Bun.secrets.delete({ service, name: slot })
      else await Bun.secrets.set({ service, name: slot, value: key })
    },
  }
}
