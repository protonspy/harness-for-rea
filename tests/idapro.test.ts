import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DatabaseTargetSchema,
  IDA_PRO_INFO,
  IDA_PRO_TOOLS,
  IdaProConfigSchema,
  PLUGIN_ENTRY,
  PLUGIN_INTERNAL,
  PLUGIN_PACKAGE,
  PLUGIN_TOOLS,
  PLUGIN_VERSION,
} from "../src/shared/idapro"
import { checkedTools, defaultIntegrationSettings, toolChoice } from "../src/shared/integrations"
import { idaPro, pluginFiles, userDir } from "../src/main/idapro/integration"
import { BridgeClient } from "../src/main/cheatengine/pipe"

/* specs/ida-pro: the catalog, the plugin's tools, and the integration, against a fake plugin. */

const PLUGIN_DIR = join(__dirname, "..", "sandbox", "ida-pro")
const PACKAGE_DIR = join(PLUGIN_DIR, PLUGIN_PACKAGE)
const python = (f: string) => readFileSync(join(PACKAGE_DIR, f), "utf8")

const SHA = "a".repeat(64)
const OTHER = "b".repeat(64)
const db = (sha256 = SHA) => ({ input_name: "sample.exe", input_path: "C:\\s\\sample.exe", idb_path: "C:\\s\\sample.exe.i64", sha256 })

type Handler = (params: Record<string, unknown>) => unknown

/** A plugin on a local socket that speaks the real one's framing; `handlers` answer by method, a throw as an error. */
class FakePlugin {
  server: Server
  path = process.platform === "win32" ? `\\\\.\\pipe\\hfr-ida-test-${randomUUID()}` : join(tmpdir(), `hfr-ida-${randomUUID()}.sock`)
  calls: { method: string; params: Record<string, unknown> }[] = []
  /** a method after whose answer the plugin drops the connection, as IDA closing does */
  dropAfter?: string
  constructor(public handlers: Record<string, Handler>) {
    this.server = createServer((s: Socket) => {
      let buf = Buffer.alloc(0)
      s.on("data", (c: Buffer) => {
        buf = Buffer.concat([buf, c])
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
          const n = buf.readUInt32LE(0)
          const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"))
          buf = buf.subarray(4 + n)
          this.calls.push({ method: req.method, params: req.params })
          const h = this.handlers[req.method]
          let msg: unknown
          try {
            msg = h
              ? { jsonrpc: "2.0", id: req.id, result: h(req.params ?? {}) }
              : { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
          } catch (e) {
            msg = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (e as Error).message } }
          }
          const body = Buffer.from(JSON.stringify(msg))
          const head = Buffer.alloc(4)
          head.writeUInt32LE(body.length)
          s.write(Buffer.concat([head, body]))
          if (req.method === this.dropAfter) s.destroy()
        }
      })
      s.on("error", () => undefined)
    })
  }
  listen() {
    return new Promise<void>((r) => this.server.listen(this.path, r))
  }
  close() {
    return new Promise<void>((r) => this.server.close(() => r()))
  }
}

const plugins: FakePlugin[] = []
const clients: BridgeClient[] = []
async function fake(handlers: Record<string, Handler>) {
  const p = new FakePlugin(handlers)
  await p.listen()
  plugins.push(p)
  const client = new BridgeClient({ path: p.path, timeoutMs: 2000, engine: "IDA Pro", peer: "The IDA Pro plugin" })
  clients.push(client)
  return { p, client }
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const p of plugins.splice(0)) await p.close()
})

const alive = (database = db()) => ({
  ping: () => ({ version: PLUGIN_VERSION, ida: "9.2", python: "3.12.4" }),
  get_database: () => database,
})

describe("the catalog (R2.1, R2.4, R2.5, R3.1, R3.2)", () => {
  it("defaults status to the orchestrator, and no other tool", () => {
    const s = defaultIntegrationSettings(IDA_PRO_INFO)
    expect(IDA_PRO_TOOLS.filter((t) => toolChoice(t, s).orchestrator).map((t) => t.name)).toEqual(["status"])
    expect(IDA_PRO_TOOLS.every((t) => toolChoice(t, s).specialist)).toBe(true)
  })

  it("needs a target for every tool but status and int_convert", () => {
    expect(IDA_PRO_TOOLS.filter((t) => !t.target).map((t) => t.name)).toEqual(["status", "int_convert"])
  })

  it("offers nothing while it is off, the integration's default", () => {
    expect(checkedTools(IDA_PRO_TOOLS, defaultIntegrationSettings(IDA_PRO_INFO), "specialist")).toEqual([])
  })

  it("takes one database by its input file's SHA-256 as its target", () => {
    expect(DatabaseTargetSchema.parse({ sha256: "A".repeat(64) })).toEqual({ sha256: SHA })
    expect(() => DatabaseTargetSchema.parse({ sha256: "abc" })).toThrow()
    expect(() => DatabaseTargetSchema.parse({ sha256: SHA, idb: "x" })).toThrow()
  })

  it("holds every tool's arguments strict, so no call carries a target or an argument upstream does not take", () => {
    const decompile = IDA_PRO_TOOLS.find((t) => t.name === "decompile")!
    expect(decompile.schema.safeParse({ addr: "main", max_lines: 100 }).success).toBe(true)
    expect(decompile.schema.safeParse({ addr: "main", target: { sha256: SHA } }).success).toBe(false)
    expect(decompile.schema.safeParse({ addr: "main", max_lines: 5001 }).success).toBe(false)
    const xrefs = IDA_PRO_TOOLS.find((t) => t.name === "xref_query")!
    expect(xrefs.schema.safeParse({ queries: [{ addr: "0x401000", direction: "to" }] }).success).toBe(true)
    expect(xrefs.schema.safeParse({ queries: { addr: "0x401000", rename: "x" } }).success).toBe(false)
  })

  it("takes a local folder as IDA's user folder, never a network path, and defaults it under %APPDATA% (R1.1)", () => {
    expect(IdaProConfigSchema.safeParse({ userDir: "\\\\server\\share\\ida" }).success).toBe(false)
    expect(IdaProConfigSchema.safeParse({ userDir: "/\\server\\share\\ida" }).success).toBe(false)
    expect(IdaProConfigSchema.safeParse({ userDir: "//server/share/ida" }).success).toBe(false)
    expect(userDir({ userDir: "D:\\ida-user" }, "C:\\AppData")).toBe("D:\\ida-user")
    expect(userDir({ userDir: "" }, "C:\\AppData")).toBe(join("C:\\AppData", "Hex-Rays", "IDA Pro"))
  })
})

describe("the plugin (R2.1, R2.2, R2.3, R2.6)", () => {
  const apiFiles = readdirSync(PACKAGE_DIR).filter((f) => f.endsWith(".py"))

  it("registers exactly the catalog's tools, every other upstream tool deleted", () => {
    const tools = apiFiles.flatMap((f) => [...python(f).matchAll(/^@tool\r?\n(?:@[\w.]+(?:\([^)]*\))?\r?\n)*def (\w+)\(/gm)].map((m) => m[1]))
    expect(tools.sort()).toEqual([...PLUGIN_TOOLS].sort())
  })

  it("names each tool's arguments as the Python function does", () => {
    const params = new Map<string, string[]>()
    for (const f of apiFiles)
      for (const m of python(f).matchAll(/^@tool\r?\n(?:@[\w.]+(?:\([^)]*\))?\r?\n)*def (\w+)\(([\s\S]*?)\)\s*->/gm))
        params.set(
          m[1],
          [...m[2].matchAll(m[2].includes("\n") ? /^ {4}(\w+)\s*:/gm : /(?:^|,)\s*(\w+)\s*:/g)].map((a) => a[1]),
        )
    for (const t of IDA_PRO_TOOLS.filter((x) => x.name !== "status"))
      expect([t.name, Object.keys(t.schema.shape).sort()]).toEqual([t.name, [...(params.get(t.name) ?? [])].sort()])
  })

  it("fills the tool table only through @tool", () => {
    const writers = apiFiles.filter((f) => /\bTOOLS\s*\[/.test(python(f)))
    expect(writers).toEqual(["rpc.py"])
  })

  it("carries none of upstream's unsafe, write or server modules", () => {
    for (const f of ["api_modify.py", "api_debug.py", "api_python.py", "api_sigmaker.py", "http.py", "trace.py", "zeromcp"])
      expect(readdirSync(PACKAGE_DIR)).not.toContain(f)
    for (const f of apiFiles) expect(python(f)).not.toMatch(/\b(py_eval|dbg_start|patch_asm|set_comments|idb_save|apply_tinfo)\b/)
  })

  it("answers only ping and get_database of its own, on its own local-only pipe", () => {
    const entry = readFileSync(join(PLUGIN_DIR, PLUGIN_ENTRY), "utf8")
    const internal = [...entry.matchAll(/"(\w+)":\s*(?:lambda|database)/g)].map((m) => m[1])
    expect(internal.sort()).toEqual([...PLUGIN_INTERNAL].sort())
    expect(entry).toContain(`VERSION = "${PLUGIN_VERSION}"`)
    const pipe = python("pipe.py")
    expect(pipe).toContain('PIPE_NAME = r"\\\\.\\pipe\\hfr-ida"')
    expect(pipe).toMatch(/PIPE_REJECT_REMOTE_CLIENTS/)
    expect(pipe).toMatch(/FILE_FLAG_FIRST_PIPE_INSTANCE/)
    expect(pipe).toMatch(/METHOD_NOT_FOUND = -32601/)
  })

  it("carries upstream's MIT notice and commit", () => {
    expect(python("LICENSE")).toMatch(/MIT License[\s\S]*Duncan Ogilvie/)
    expect(python("UPSTREAM.md")).toContain("c133c3853faa111a9b00ee615c013b720d0c4acd")
    expect(readFileSync(join(PLUGIN_DIR, PLUGIN_ENTRY), "utf8")).toContain("c133c3853faa111a9b00ee615c013b720d0c4acd")
  })
})

describe("checks, install and status (R1.2, R1.3, R1.4, R2.4)", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hfr-ida-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it("fails the install check until the plugin is installed, then passes it", async () => {
    const { client } = await fake(alive())
    const ida = idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home })
    const before = await ida.checks({ userDir: "" })
    expect(before.map((c) => [c.name, c.ok])).toEqual([
      ["Plugin installed", false],
      ["Plugin answers", true],
    ])
    expect(before[0].fix).toMatch(/Install the plugin/)
    const r = await ida.runAction({ userDir: "" }, "install-plugin")
    expect(r.ok).toBe(true)
    const installed = join(home, "Hex-Rays", "IDA Pro", "plugins")
    for (const f of pluginFiles(PLUGIN_DIR)) expect(readFileSync(join(installed, f)).equals(readFileSync(join(PLUGIN_DIR, f)))).toBe(true)
    expect((await ida.checks({ userDir: "" })).every((c) => c.ok)).toBe(true)
  })

  it("fails the install check for a plugin that is not the one the app carries", async () => {
    const { client } = await fake(alive())
    const ida = idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home })
    await ida.runAction({ userDir: home }, "install-plugin")
    writeFileSync(join(home, "plugins", PLUGIN_PACKAGE, "pipe.py"), "# changed")
    const [installed] = await ida.checks({ userDir: home })
    expect(installed.ok).toBe(false)
    expect(installed.detail).toMatch(/1 file differ/)
  })

  it("fails the answer check for a plugin of another version, or none", async () => {
    const { client } = await fake({ ...alive(), ping: () => ({ version: "hfr-ida-0" }) })
    const old = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home }).checks({ userDir: "" })
    expect(old[1]).toMatchObject({ ok: false, fix: expect.stringMatching(/Install the plugin again/) })
    const none = new BridgeClient({ path: join(home, "nothing"), timeoutMs: 500, engine: "IDA Pro", peer: "The IDA Pro plugin" })
    clients.push(none)
    const off = await idaPro({ pluginDir: PLUGIN_DIR, bridge: none, appData: home }).checks({ userDir: "" })
    expect(off[1]).toMatchObject({ ok: false, detail: expect.stringMatching(/^The IDA Pro plugin is not answering/) })
  })

  it("returns the plugin's path and the folder to copy it into when it cannot write there (R1.4)", async () => {
    const { client } = await fake(alive())
    // A file where the plugins folder should be: nothing can be written under it.
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "plugins"), "")
    const r = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home }).runAction({ userDir: home }, "install-plugin")
    expect(r.ok).toBe(false)
    expect(r.paths).toEqual([
      { label: "The plugin", path: PLUGIN_DIR },
      { label: "Copy it into", path: join(home, "plugins") },
    ])
  })

  it("answers status with the versions, the open database and the tools, and nothing else from it (R2.4)", async () => {
    const { p, client } = await fake(alive())
    const s = (await idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home }).call({}, "status", {})) as Record<string, unknown>
    expect(s).toMatchObject({
      connected: true,
      idaVersion: "9.2",
      pythonVersion: "3.12.4",
      pluginVersion: PLUGIN_VERSION,
      database: { input_name: "sample.exe", idb_name: "sample.exe.i64", sha256: SHA },
    })
    expect(s.tools).toEqual(IDA_PRO_TOOLS.map((t) => t.name))
    expect(p.calls.map((c) => c.method)).toEqual(["ping", "get_database"])
  })

  it("forwards int_convert without a target, and refuses a target tool outside a session (R3.2)", async () => {
    const { client } = await fake({ ...alive(), int_convert: () => [{ hex: "0x10" }] })
    const ida = idaPro({ pluginDir: PLUGIN_DIR, bridge: client, appData: home })
    expect(await ida.call({}, "int_convert", { inputs: { text: "16" } })).toEqual([{ hex: "0x10" }])
    await expect(ida.call({}, "decompile", { addr: "main" })).rejects.toThrow(/approved database/)
  })
})

describe("the database (R3.1, R3.3, R3.4)", () => {
  it("describes the database by input name, path and SHA-256", async () => {
    const { client } = await fake(alive())
    const ida = idaPro({ pluginDir: PLUGIN_DIR, bridge: client })
    expect(await ida.describeTarget({}, { sha256: SHA })).toBe(`sample.exe — C:\\s\\sample.exe.i64 (sha256 ${SHA})`)
    expect(await ida.identify!({}, { sha256: SHA })).toBe(JSON.stringify([SHA, "C:\\s\\sample.exe.i64"]))
  })

  it("refuses to describe a database IDA does not have open", async () => {
    const { client } = await fake(alive())
    const ida = idaPro({ pluginDir: PLUGIN_DIR, bridge: client })
    await expect(ida.describeTarget({}, { sha256: OTHER })).rejects.toThrow(/not the approved database/)
    expect(await ida.identify!({}, { sha256: OTHER })).toBeNull()
  })

  it("forwards a session's calls while the approved database is open, checking it before each", async () => {
    const { p, client } = await fake({ ...alive(), decompile: (a) => ({ addr: a.addr, code: "int main() {}" }) })
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    expect(await s.call("decompile", { addr: "main" })).toEqual({ addr: "main", code: "int main() {}" })
    expect(p.calls.map((c) => c.method)).toEqual(["get_database", "get_database", "decompile"])
  })

  it("refuses a call once IDA has another database open, and sends nothing to it", async () => {
    let open = db()
    const { p, client } = await fake({ ping: alive().ping, get_database: () => open, decompile: () => "leaked" })
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    open = db(OTHER)
    await expect(s.call("decompile", { addr: "main" })).rejects.toThrow(/IDA Pro has sample\.exe .* open, not the approved database/)
    expect(p.calls.some((c) => c.method === "decompile")).toBe(false)
  })

  it("refuses a call once IDA has the same input open in another database", async () => {
    let open = db()
    const { client } = await fake({ ping: alive().ping, get_database: () => open, decompile: () => "read" })
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    open = { ...db(), idb_path: "C:\\other\\sample.exe.i64" }
    await expect(s.call("decompile", { addr: "main" })).rejects.toThrow(/not the approved database/)
  })

  it("refuses a call whose connection dropped between the check and the call, sending it nowhere", async () => {
    const { p, client } = await fake({ ...alive(), decompile: () => "read" })
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    p.dropAfter = "get_database"
    await expect(s.call("decompile", { addr: "main" })).rejects.toThrow(/closed the connection|was reopened during decompile/)
    expect(p.calls.some((c) => c.method === "decompile")).toBe(false)
  })

  it("fails a unit whose connection was reopened between its calls, before sending the rest", async () => {
    const { p, client } = await fake(alive())
    const unit = client.exclusive(async (send) => {
      await send("get_database")
      // The plugin went away and another took the pipe: the next send connects anew.
      ;(client as unknown as { socket: { destroy(): void } }).socket.destroy()
      await new Promise((r) => setImmediate(r))
      return send("decompile", { addr: "main" })
    })
    await expect(unit).rejects.toThrow(/The connection to IDA Pro was reopened during decompile/)
    expect(p.calls.map((c) => c.method)).toEqual(["get_database"])
  })

  it("refuses to open a session on a database IDA does not have open", async () => {
    const { client } = await fake(alive(db(OTHER)))
    await expect(idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })).rejects.toThrow(/not the approved database/)
  })

  it("answers a call with an error saying the plugin is not answering once IDA closed (R3.4)", async () => {
    const { p, client } = await fake(alive())
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    client.close()
    await p.close()
    plugins.splice(plugins.indexOf(p), 1)
    await expect(s.call("decompile", { addr: "main" })).rejects.toThrow(/^The IDA Pro plugin is not answering/)
  })

  it("passes a tool's own error back as the call's error", async () => {
    const { client } = await fake({
      ...alive(),
      decompile: () => {
        throw new Error("Not found: 'nope'")
      },
    })
    const s = await idaPro({ pluginDir: PLUGIN_DIR, bridge: client }).session({}, { sha256: SHA })
    await expect(s.call("decompile", { addr: "nope" })).rejects.toThrow("Not found: 'nope'")
  })
})
