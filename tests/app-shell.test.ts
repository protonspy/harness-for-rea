import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { stub } from "./electron-stub"
import { closeDb, getDb, getSetting, openDb, setSetting } from "../src/main/db"
import { clearKey, CredentialError, initKey, keyStatus, onKey, readKey, saveKey } from "../src/main/credentials"
import { isAppPage, makeDispatcher } from "../src/main/ipc"
import { contentSecurityPolicy } from "../src/main/csp"
import { lockNavigation, webPreferences } from "../src/main/window"
import { API_METHODS, API_SCHEMAS, type Handlers } from "../src/shared/api"

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
    await expect(dispatch(PAGE, "startTask", [{ request: "", sourceRoot: "C:/x" }])).rejects.toThrow(/invalid arguments/)
    expect(ran).toEqual([])
  })

  it("has a schema for every method the bridge exposes", () => {
    for (const m of API_METHODS) expect(API_SCHEMAS[m]).toBeDefined()
  })
})

describe("credentials (R3.1–R3.3)", () => {
  beforeAll(() => openDb(":memory:"))
  afterAll(() => closeDb())
  beforeEach(() => {
    stub.encryption = true
    clearKey()
  })

  it("stores the key only encrypted and reads it back after a restart", () => {
    saveKey("  sk-or-v1-abcdef1234567890  ")
    const stored = getSetting<string>("openrouter.key", "")
    expect(Buffer.from(stored, "base64").toString()).toBe("enc:sk-or-v1-abcdef1234567890")
    initKey()
    expect(readKey()).toBe("sk-or-v1-abcdef1234567890")
  })

  it("refuses to store the key when encryption is unavailable, writing nothing", () => {
    stub.encryption = false
    expect(() => saveKey("sk-or-v1-abcdef1234567890")).toThrow(CredentialError)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 })
    expect(readKey()).toBeNull()
  })

  it("exposes only whether a key is set and a masked hint", () => {
    expect(keyStatus()).toEqual({ set: false, hint: "", encryption: true })
    const s = saveKey("sk-or-v1-abcdef1234567890")
    expect(s.set).toBe(true)
    expect(s.hint).toBe("sk-or-…7890")
    expect(JSON.stringify(s)).not.toContain("abcdef123456")
  })

  it("hands the key to listeners so it can be redacted", () => {
    const seen: string[] = []
    onKey((k) => seen.push(k))
    saveKey("sk-or-v1-zzzzzzzz9999")
    expect(seen).toContain("sk-or-v1-zzzzzzzz9999")
  })

  it("forgets the key when cleared, and treats a corrupt record as no key", () => {
    saveKey("sk-or-v1-abcdef1234567890")
    clearKey()
    initKey()
    expect(readKey()).toBeNull()
    setSetting("openrouter.key", "!!!")
    stub.encryption = false
    initKey()
    expect(readKey()).toBeNull()
  })
})
