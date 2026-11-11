import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { stub, safeStorage } from "./electron-stub"
import { closeDb, getDb, getSetting, openDb, setSetting } from "../src/main/db"
import {
  clearKey,
  CredentialError,
  initKey,
  keyStatus,
  onKey,
  readKey,
  refreshKeyAvailability,
  saveKey,
  useKeyStore,
  type KeyStore,
} from "../src/main/credentials"
import { electronKeyStore } from "../src/main/keys-electron"
import { isAppPage, makeDispatcher } from "../src/main/ipc"
import { contentSecurityPolicy } from "../src/main/csp"
import { lockNavigation, webPreferences } from "../src/main/window"
import { API_METHODS, API_SCHEMAS, type Handlers } from "../src/shared/api"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import { PROVIDERS, resolveBaseUrl } from "../src/shared/providers"

/* specs/app-shell: the window's hardening, the validated IPC contract and the credential store. */

const PAGE = "file:///C:/app/out/renderer/index.html"

describe("window (R1.1–R1.3)", () => {
  it("isolates the renderer from Node and the machine", () => {
    const p = webPreferences("/preload.js")
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
    })
  })

  it("blocks navigation away from the app's page and every new window", () => {
    let navigate: (e: { preventDefault(): void }, url: string) => void = () => undefined
    let open: (d: { url: string }) => { action: "deny" } = () => ({ action: "deny" })
    lockNavigation({ on: (_e, l) => (navigate = l), setWindowOpenHandler: (h) => (open = h) }, PAGE)
    const away = { preventDefault: vi.fn() }
    navigate(away, "https://evil.example/")
    expect(away.preventDefault).toHaveBeenCalled()
    const home = { preventDefault: vi.fn() }
    navigate(home, `${PAGE}#/tasks`)
    expect(home.preventDefault).not.toHaveBeenCalled()
    expect(open({ url: "https://claude.ai" })).toEqual({ action: "deny" })
  })

  it("allows scripts only from the app itself", () => {
    const csp = contentSecurityPolicy()
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
    expect(csp).toContain("default-src 'none'")
    expect(contentSecurityPolicy("http://localhost:5173")).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173")
  })
})

describe("IPC (R2.1–R2.3)", () => {
  const ran: unknown[][] = []
  const handlers = Object.fromEntries(API_METHODS.map((m) => [m, (...a: unknown[]) => (ran.push([m, ...a]), "ok")])) as unknown as Handlers
  const dispatch = makeDispatcher(handlers, () => PAGE)

  beforeEach(() => {
    ran.length = 0
  })

  it("matches only the app's page", () => {
    expect(isAppPage(`${PAGE}?x=1#y`, PAGE)).toBe(true)
    expect(isAppPage("file:///C:/other/index.html", PAGE)).toBe(false)
    expect(isAppPage("not a url", PAGE)).toBe(false)
  })

  it("runs a known method with parsed arguments, defaults filled", async () => {
    await expect(dispatch(PAGE, "listTasks", [{}])).resolves.toBe("ok")
    expect(ran).toEqual([["listTasks", { limit: 50 }]])
  })

  it("rejects a call from another frame without running it", async () => {
    await expect(dispatch("https://evil.example/", "listTasks", [{}])).rejects.toThrow(/app's page/)
    expect(ran).toEqual([])
  })

  it("rejects an unknown method, including prototype names", async () => {
    await expect(dispatch(PAGE, "eval", [])).rejects.toThrow(/not an API method/)
    await expect(dispatch(PAGE, "constructor", [])).rejects.toThrow(/not an API method/)
    await expect(dispatch(PAGE, 42, [])).rejects.toThrow(/not an API method/)
    expect(ran).toEqual([])
  })

  it("rejects arguments that fail the method's schema", async () => {
    await expect(dispatch(PAGE, "cancelTask", ["../../etc"])).rejects.toThrow(/invalid arguments for cancelTask/)
    await expect(dispatch(PAGE, "saveSettings", [{ model: "x; rm -rf /" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveSettings", [{ extra: 1 }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveSettings", [{ provider: "nope" }])).rejects.toThrow(/invalid arguments/)
    for (const baseUrl of ["file:///etc/passwd", "not a url", "https://user:pw@host.example/v1"])
      await expect(dispatch(PAGE, "saveSettings", [{ baseUrl }])).rejects.toThrow(/invalid arguments/)
    // Each provider's base URL is the main process's to keep: the view sets the chosen one's, never the map (specs/orchestrator R1.10).
    await expect(dispatch(PAGE, "saveSettings", [{ baseUrls: { custom: "https://attacker.example/v1" } }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveKey", ["sk-deepseek-1234567890", "nope"])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveSettings", [{ specialistEffort: "ultra" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "startTask", [{ request: "", sourceRoot: "C:/x" }])).rejects.toThrow(/invalid arguments/)
    // a project's and a task's model: known fields only, a model name with no control characters (specs/projects R1.8, R2.6)
    const pid = "00000000-0000-4000-8000-000000000001"
    await expect(dispatch(PAGE, "updateProject", [pid, { model: "a\u001b]0;x\u0007b" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "updateProject", [pid, { folder: "C:/" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "setTaskModel", [pid, "line\nbreak"])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "setTaskModel", ["not-an-id", "m"])).rejects.toThrow(/invalid arguments/)
    expect(ran).toEqual([])
    await expect(dispatch(PAGE, "setTaskModel", [pid, " qwen/qwen3.8-flash "])).resolves.toBe("ok")
    expect(ran).toEqual([["setTaskModel", pid, "qwen/qwen3.8-flash"]])
    ran.length = 0
  })

  it("validates the chat's calls (specs/chat R7)", async () => {
    const t = "00000000-0000-4000-8000-000000000001"
    const c = "00000000-0000-4000-8000-000000000002"
    await dispatch(PAGE, "startTask", [{ request: "x", sourceRoot: "C:/x" }])
    expect(ran.at(-1)).toEqual(["startTask", { request: "x", sourceRoot: "C:/x" }])
    await dispatch(PAGE, "decideTool", [t, c, { type: "edit", args: { command: "ls" } }])
    await dispatch(PAGE, "decideTool", [t, c, { type: "reject", message: "no" }])
    await dispatch(PAGE, "answerQuestion", [t, c, true])
    await dispatch(PAGE, "sendMessage", [t, "  also check b.ts  "])
    expect(ran.at(-1)).toEqual(["sendMessage", t, "also check b.ts"])
    for (const m of ["stopTurn", "continueTurn", "closeTask"]) await dispatch(PAGE, m, [t])
    // The renderer cannot ask for gates: every task runs its calls without asking (specs/chat R4.1).
    await expect(dispatch(PAGE, "startTask", [{ request: "x", sourceRoot: "C:/x", gated: ["apply_patch"] }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "startTask", [{ request: "x", sourceRoot: "C:/x", auto: false }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "decideTool", [t, c, { type: "maybe" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "decideTool", [t, c, { type: "approve", args: {} }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "answerQuestion", [t, c, { evil: 1 }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "sendMessage", [t, "   "])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveSettings", [{ approvalTimeoutMinutes: 0 }])).rejects.toThrow(/invalid arguments/)
  })

  it("takes the specialist's provider and model, the Claude plan or an orchestrator provider (specs/specialist-providers R1.1)", async () => {
    await dispatch(PAGE, "saveSettings", [{ specialistProvider: "openrouter", specialistModel: " qwen/qwen3.8-flash " }])
    expect(ran.at(-1)).toEqual(["saveSettings", { specialistProvider: "openrouter", specialistModel: "qwen/qwen3.8-flash" }])
    await dispatch(PAGE, "saveSettings", [{ specialistProvider: "claude", specialistModel: "" }])
    expect(ran.at(-1)).toEqual(["saveSettings", { specialistProvider: "claude", specialistModel: "" }])
    ran.length = 0
    await expect(dispatch(PAGE, "saveSettings", [{ specialistProvider: "anthropic" }])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "saveSettings", [{ specialistModel: "a\u001b]0;x\u0007b" }])).rejects.toThrow(/invalid arguments/)
    expect(ran).toEqual([])
    expect(DEFAULT_SETTINGS).toMatchObject({
      provider: "hopper",
      model: "deepseek-v4.1-flash-1017-abliterated",
      specialistProvider: "hopper",
      specialistModel: "deepseek-v4.1-flash-1017-abliterated",
    })
  })

  it("starts both agents on Hopper, at its fixed endpoint, with its account link and offer (specs/specialist-providers R1.4, R1.5)", async () => {
    expect(PROVIDERS.hopper).toMatchObject({
      kind: "openai",
      baseUrl: "https://api.withhopper.com/v1",
      keyRequired: true,
      signupUrl: "https://withhopper.com/cyber",
    })
    expect(PROVIDERS.hopper.offer).toMatch(/20% off/)
    // Not editable: a base URL saved for it never redirects its key elsewhere.
    expect(resolveBaseUrl("hopper", "https://attacker.example/v1")).toBe("https://api.withhopper.com/v1")
    // The renderer names the provider; the address opened is the preset's alone.
    await expect(dispatch(PAGE, "openProviderSignup", ["https://evil.example"])).rejects.toThrow(/invalid arguments/)
    await expect(dispatch(PAGE, "openProviderSignup", ["hopper"])).resolves.toBe("ok")
    ran.length = 0
  })

  it("has a schema for every method the bridge exposes", () => {
    for (const m of API_METHODS) expect(API_SCHEMAS[m]).toBeDefined()
  })
})

describe("credentials (R3.1–R3.3)", () => {
  beforeAll(() => {
    openDb(":memory:")
    useKeyStore(electronKeyStore())
  })
  afterAll(() => closeDb())
  beforeEach(async () => {
    useKeyStore(electronKeyStore())
    stub.encryption = true
    await clearKey()
  })
  afterEach(async () => {
    useKeyStore(electronKeyStore())
    stub.encryption = true
  })

  it("stores the key only encrypted and reads it back after a restart", async () => {
    await saveKey("  sk-or-v1-abcdef1234567890  ")
    const stored = getSetting<string>("openrouter.key", "")
    expect(Buffer.from(stored, "base64").toString()).toBe("enc:sk-or-v1-abcdef1234567890")
    await initKey()
    expect(readKey()).toBe("sk-or-v1-abcdef1234567890")
  })

  it("refuses to store the key when encryption is unavailable, writing nothing", async () => {
    stub.encryption = false
    await expect(saveKey("sk-or-v1-abcdef1234567890")).rejects.toThrow(CredentialError)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key <> 'schema.by'").get()).toEqual({ n: 0 })
    expect(readKey()).toBeNull()
  })

  it("exposes only whether a key is set and a masked hint", async () => {
    expect(keyStatus()).toEqual({ set: false, hint: "", encryption: true })
    const s = await saveKey("sk-or-v1-abcdef1234567890")
    expect(s.set).toBe(true)
    expect(s.hint).toBe("…7890")
    expect(JSON.stringify(s)).not.toContain("abcdef123456")
  })

  it("hands the key to listeners so it can be redacted", async () => {
    const seen: string[] = []
    onKey((k) => seen.push(k))
    await saveKey("sk-or-v1-zzzzzzzz9999")
    expect(seen).toContain("sk-or-v1-zzzzzzzz9999")
  })

  it("keeps one key per provider, OpenRouter's in its original slot", async () => {
    await saveKey("sk-or-v1-abcdef1234567890")
    await saveKey("sk-deepseek-1234567890", "deepseek")
    expect(getSetting<string>("openrouter.key", "")).not.toBe("")
    expect(getSetting<string>("deepseek.key", "")).not.toBe("")
    await initKey()
    expect(readKey()).toBe("sk-or-v1-abcdef1234567890")
    expect(readKey("deepseek")).toBe("sk-deepseek-1234567890")
    expect(readKey("custom")).toBeNull()
    expect(keyStatus("deepseek").hint).toBe("…7890")
    await clearKey("deepseek")
    expect(readKey("deepseek")).toBeNull()
    expect(readKey()).toBe("sk-or-v1-abcdef1234567890")
    const seen: string[] = []
    onKey((k) => seen.push(k))
    expect(seen).toEqual(["sk-or-v1-abcdef1234567890"])
  })

  it("forgets the key when cleared, and treats a corrupt record as no key", async () => {
    await saveKey("sk-or-v1-abcdef1234567890")
    await clearKey()
    await initKey()
    expect(readKey()).toBeNull()
    setSetting("openrouter.key", "!!!")
    stub.encryption = false
    await initKey()
    expect(readKey()).toBeNull()
  })

  it("uses safeStorage.isAsyncEncryptionAvailable when present and avoids deprecated sync call", async () => {
    const origSync = safeStorage.isEncryptionAvailable
    const origAsync = safeStorage.isAsyncEncryptionAvailable
    const syncSpy = vi.fn(() => true)
    const asyncSpy = vi.fn(async () => true)
    safeStorage.isEncryptionAvailable = syncSpy
    safeStorage.isAsyncEncryptionAvailable = asyncSpy

    try {
      const store = electronKeyStore()
      const avail = await store.available()
      expect(avail).toBe(true)
      expect(asyncSpy).toHaveBeenCalledTimes(1)
      expect(syncSpy).not.toHaveBeenCalled()
    } finally {
      safeStorage.isEncryptionAvailable = origSync
      safeStorage.isAsyncEncryptionAvailable = origAsync
    }
  })

  it("falls back to safeStorage.isEncryptionAvailable if async method is unavailable", async () => {
    const origSync = safeStorage.isEncryptionAvailable
    const origAsync = safeStorage.isAsyncEncryptionAvailable
    const syncSpy = vi.fn(() => true)
    safeStorage.isEncryptionAvailable = syncSpy
    // @ts-expect-error test fallback when isAsyncEncryptionAvailable is undefined
    delete safeStorage.isAsyncEncryptionAvailable

    try {
      const store = electronKeyStore()
      const avail = await store.available()
      expect(avail).toBe(true)
      expect(syncSpy).toHaveBeenCalledTimes(1)
    } finally {
      safeStorage.isEncryptionAvailable = origSync
      safeStorage.isAsyncEncryptionAvailable = origAsync
    }
  })

  it("transitions availability from false to true on explicit refresh", async () => {
    let availState = false
    const asyncStore: KeyStore = {
      available: () => Promise.resolve(availState),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(asyncStore)
    expect(keyStatus().encryption).toBe(false)
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(false)

    availState = true
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(true)
  })

  it("transitions availability from true to false on explicit refresh", async () => {
    let availState = true
    const asyncStore: KeyStore = {
      available: () => Promise.resolve(availState),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(asyncStore)
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(true)

    availState = false
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(false)
  })

  it("handles key store available() rejection safely without unhandledRejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => unhandled.push(err)
    process.on("unhandledRejection", onUnhandled)

    try {
      const rejectingStore: KeyStore = {
        available: () => Promise.reject(new Error("keychain daemon unavailable")),
        read: async () => null,
        write: async () => {},
      }
      useKeyStore(rejectingStore)
      const res = await refreshKeyAvailability()
      expect(res).toBe(false)
      expect(keyStatus().encryption).toBe(false)
      // Multiple keyStatus calls must not trigger unhandled promises or throw
      expect(keyStatus().encryption).toBe(false)
      expect(keyStatus().encryption).toBe(false)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("does not start unobserved calls on async store when keyStatus is queried", async () => {
    let probeCount = 0
    const asyncStore: KeyStore = {
      available: () => {
        probeCount++
        return Promise.resolve(true)
      },
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(asyncStore)
    await refreshKeyAvailability()
    const baseline = probeCount

    // Repeated synchronous status queries
    keyStatus()
    keyStatus("openrouter")
    keyStatus("deepseek")
    expect(probeCount).toBe(baseline)
  })

  it("resets availability safely when changing the key store", async () => {
    const storeA: KeyStore = {
      available: () => Promise.resolve(true),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(storeA)
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(true)

    const storeB: KeyStore = {
      available: () => Promise.resolve(false),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(storeB)
    expect(keyStatus().encryption).toBe(false)
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(false)
  })

  it("shares concurrent in-flight availability probes without redundant available() calls", async () => {
    let callCount = 0
    let resolveProbe!: (v: boolean) => void
    const asyncStore: KeyStore = {
      available: () => {
        callCount++
        return new Promise((r) => {
          resolveProbe = r
        })
      },
      read: async () => null,
      write: async () => {},
    }

    useKeyStore(asyncStore)
    expect(callCount).toBe(0)

    const probe1 = refreshKeyAvailability()
    const probe2 = refreshKeyAvailability()
    const probe3 = refreshKeyAvailability()
    expect(callCount).toBe(1)

    resolveProbe(true)
    const [r1, r2, r3] = await Promise.all([probe1, probe2, probe3])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(r3).toBe(true)
    expect(callCount).toBe(1)
    expect(keyStatus().encryption).toBe(true)
  })

  it("prevents out-of-order probe resolutions from overwriting newer availability state", async () => {
    let resolveProbeA!: (v: boolean) => void
    let rejectProbeA!: (err: unknown) => void

    const storeA: KeyStore = {
      available: () =>
        new Promise((resolve, reject) => {
          resolveProbeA = resolve
          rejectProbeA = reject
        }),
      read: async () => null,
      write: async () => {},
    }

    // Start probe A on storeA
    useKeyStore(storeA)
    const pendingA = refreshKeyAvailability()

    // Store switch or new cycle creates generation 2 with storeB
    const storeB: KeyStore = {
      available: () => Promise.resolve(true),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(storeB)
    const resB = await refreshKeyAvailability()
    expect(resB).toBe(true)
    expect(keyStatus().encryption).toBe(true)

    // Probe A finishes later with false: it must NOT overwrite storeB's newer status
    resolveProbeA(false)
    await pendingA
    expect(keyStatus().encryption).toBe(true)

    // Similarly, obsolete probe rejection must not flip newer status or throw
    const storeC: KeyStore = {
      available: () =>
        new Promise((_, reject) => {
          rejectProbeA = reject
        }),
      read: async () => null,
      write: async () => {},
    }
    useKeyStore(storeC)
    const pendingC = refreshKeyAvailability()

    useKeyStore(storeB)
    await refreshKeyAvailability()
    expect(keyStatus().encryption).toBe(true)

    rejectProbeA(new Error("delayed probe failure"))
    await pendingC.catch(() => {})
    expect(keyStatus().encryption).toBe(true)
  })

  it("ensures useKeyStore does not invoke available() and invalidates older generation on re-install", async () => {
    let callCount = 0
    let resolveProbe1!: (v: boolean) => void

    const store: KeyStore = {
      available: () => {
        callCount++
        if (callCount === 1) {
          return new Promise((r) => {
            resolveProbe1 = r
          })
        }
        return Promise.resolve(true)
      },
      read: async () => null,
      write: async () => {},
    }

    // Installing the store does not trigger probing
    useKeyStore(store)
    expect(callCount).toBe(0)
    expect(keyStatus().encryption).toBe(false)

    // Probe 1 is started
    const probe1 = refreshKeyAvailability()
    expect(callCount).toBe(1)

    // Re-installing the store advances generation and resets state
    useKeyStore(store)
    expect(keyStatus().encryption).toBe(false)

    // Probe 2 runs under new generation and resolves to true
    const res2 = await refreshKeyAvailability()
    expect(res2).toBe(true)
    expect(callCount).toBe(2)
    expect(keyStatus().encryption).toBe(true)

    // Older Probe 1 finishes late with false: must NOT overwrite newer generation's true
    resolveProbe1(false)
    await probe1
    expect(keyStatus().encryption).toBe(true)
  })
})
