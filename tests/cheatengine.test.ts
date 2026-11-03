import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BRIDGE_FILE,
  BRIDGE_INTERNAL,
  BRIDGE_METHODS,
  BRIDGE_VERSION,
  CHEAT_ENGINE_INFO,
  CHEAT_ENGINE_TOOLS,
  ProcessTargetSchema,
  READ_MEMORY_CAP,
} from "../src/shared/cheatengine"
import { checkedTools, defaultIntegrationSettings, toolChoice } from "../src/shared/integrations"
import { cheatEngine } from "../src/main/cheatengine/integration"
import { BridgeClient, BridgeError } from "../src/main/cheatengine/pipe"

/* specs/cheat-engine: the catalog, the bridge script, the pipe client and the integration, against a fake bridge. */

const LUA = join(__dirname, "..", "sandbox", "cheat-engine", "hfr-bridge.lua")
const lua = readFileSync(LUA, "utf8")

type Handler = (params: Record<string, unknown>) => unknown

/** A bridge on a local socket that speaks the real one's framing; `handlers` answer by method. */
class FakeBridge {
  server: Server
  path = process.platform === "win32" ? `\\\\.\\pipe\\hfr-test-${randomUUID()}` : join(tmpdir(), `hfr-${randomUUID()}.sock`)
  calls: { method: string; params: Record<string, unknown> }[] = []
  connections = 0
  silent = new Set<string>()
  constructor(public handlers: Record<string, Handler>) {
    this.server = createServer((s: Socket) => {
      this.connections++
      let buf = Buffer.alloc(0)
      s.on("data", (c: Buffer) => {
        buf = Buffer.concat([buf, c])
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
          const n = buf.readUInt32LE(0)
          const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"))
          buf = buf.subarray(4 + n)
          this.calls.push({ method: req.method, params: req.params })
          if (this.silent.has(req.method)) continue
          const h = this.handlers[req.method]
          const msg = h
            ? { jsonrpc: "2.0", id: req.id, result: h(req.params ?? {}) }
            : { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
          const body = Buffer.from(JSON.stringify(msg))
          const head = Buffer.alloc(4)
          head.writeUInt32LE(body.length)
          s.write(Buffer.concat([head, body]))
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

const bridges: FakeBridge[] = []
const clients: BridgeClient[] = []
async function fake(handlers: Record<string, Handler>) {
  const b = new FakeBridge(handlers)
  await b.listen()
  bridges.push(b)
  const client = new BridgeClient({ path: b.path, timeoutMs: 2000 })
  clients.push(client)
  return { b, client }
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const b of bridges.splice(0)) await b.close()
})

describe("the catalog (R2.1, R2.4, R2.5, R3.1, R3.2)", () => {
  it("defaults status and get_process_list to the orchestrator, and no other tool", () => {
    const s = defaultIntegrationSettings(CHEAT_ENGINE_INFO)
    expect(CHEAT_ENGINE_TOOLS.filter((t) => toolChoice(t, s).orchestrator).map((t) => t.name)).toEqual(["status", "get_process_list"])
    expect(CHEAT_ENGINE_TOOLS.every((t) => toolChoice(t, s).specialist)).toBe(true)
  })

  it("needs a target for every tool but status and get_process_list", () => {
    expect(CHEAT_ENGINE_TOOLS.filter((t) => !t.target).map((t) => t.name)).toEqual(["status", "get_process_list"])
  })

  it("offers nothing while it is off, the integration's default", () => {
    const s = defaultIntegrationSettings(CHEAT_ENGINE_INFO)
    expect(s.enabled).toBe(false)
    expect(checkedTools(CHEAT_ENGINE_TOOLS, s, "specialist")).toEqual([])
  })

  it("takes one process by pid as its target", () => {
    expect(ProcessTargetSchema.parse({ pid: 4242 })).toEqual({ pid: 4242 })
    expect(() => ProcessTargetSchema.parse({ pid: 0 })).toThrow()
    expect(() => ProcessTargetSchema.parse({ pid: 1, name: "x" })).toThrow()
  })

  it("holds every tool's arguments strict, so no call can carry a target or a write", () => {
    const read = CHEAT_ENGINE_TOOLS.find((t) => t.name === "read_memory")!
    expect(read.schema.safeParse({ address: "game.exe+10", size: 16 }).success).toBe(true)
    expect(read.schema.safeParse({ address: "0x10", target: { pid: 1 } }).success).toBe(false)
    expect(read.schema.safeParse({ address: "0x10", size: READ_MEMORY_CAP + 1 }).success).toBe(false)
  })

  it("takes a module or symbol name without a pointer dereference", () => {
    const symbol = CHEAT_ENGINE_TOOLS.find((t) => t.name === "get_symbol_address")!
    expect(symbol.schema.safeParse({ symbol: "kernel32.CreateFileW" }).success).toBe(true)
    expect(symbol.schema.safeParse({ symbol: "?Get@Foo@@QEAAHXZ" }).success).toBe(true)
    expect(symbol.schema.safeParse({ symbol: "[game.exe+10]" }).success).toBe(false)
  })

  it("takes a local .exe as the executable, never a network path", () => {
    const s = CHEAT_ENGINE_INFO.settingsSchema
    expect(s.safeParse({ executablePath: "C:\\Program Files\\Cheat Engine\\cheatengine-x86_64.exe" }).success).toBe(true)
    expect(s.safeParse({ executablePath: "" }).success).toBe(true)
    expect(s.safeParse({ executablePath: "\\\\server\\share\\ce.exe" }).success).toBe(false)
    expect(s.safeParse({ executablePath: "/\\server\\share\\ce.exe" }).success).toBe(false)
    expect(s.safeParse({ executablePath: "//server/share/ce.exe" }).success).toBe(false)
    expect(s.safeParse({ executablePath: "C:\\tools\\notes.txt" }).success).toBe(false)
  })

  it("refuses an address that is more than an address expression", () => {
    const read = CHEAT_ENGINE_TOOLS.find((t) => t.name === "read_memory")!
    expect(read.schema.safeParse({ address: "[[game.exe+10]+8]" }).success).toBe(true)
    expect(read.schema.safeParse({ address: 'print("x")' }).success).toBe(false)
    expect(read.schema.safeParse({ address: "a;b" }).success).toBe(false)
  })
})

describe("the bridge script (R2.1–R2.3)", () => {
  const table = /local commandHandlers = \{([\s\S]*?)\n\}/.exec(lua)![1]
  const keys = [...table.matchAll(/^\s*([a-z_0-9]+)\s*=/gm)].map((m) => m[1])

  it("holds its handler table equal to the catalog's methods plus ping, open_process and get_opened_process_id", () => {
    expect([...keys].sort()).toEqual([...BRIDGE_METHODS, ...BRIDGE_INTERNAL].sort())
  })

  it("defines no handler outside the table: the rest are deleted, not disabled", () => {
    const defined = [...lua.matchAll(/function\s+cmd_([a-z_0-9]+)\s*\(/g)].map((m) => m[1])
    expect([...defined].sort()).toEqual([...keys].sort())
  })

  it("answers an unknown method with -32601 and runs nothing", () => {
    expect(lua).toMatch(
      /local handler = commandHandlers\[method\]\s*\n\s*if not handler then\s*\n\s*return json\.encode\(\{ jsonrpc = "2\.0", error = \{ code = -32601/,
    )
  })

  it("speaks on its own pipe with the version the app carries", () => {
    expect(lua).toContain('local PIPE_NAME = "hfr-cheat-engine"')
    expect(lua).toContain(`local VERSION = "${BRIDGE_VERSION}"`)
  })

  it("carries the upstream MIT notice and commit", () => {
    expect(lua).toContain("Copyright (c) 2025 miscusi-peek")
    expect(lua).toContain("Permission is hereby granted, free of charge")
    expect(lua).toContain("6bd7ce90479250a9b4b75e7944df9c105ecb2572")
  })

  it("calls none of Cheat Engine's write, inject, execute or debug functions", () => {
    const code = lua.replace(/--.*$/gm, "")
    expect(code).not.toMatch(
      // A method on the pipe (`pipe.writeBytes`) is the transport, not Cheat Engine's API.
      /(?<![.:\w])(write(Bytes|Integer|Qword|Float|Double|String|Pointer|SmallInteger)|autoAssemble|executeCode\w*|injectDLL|createRemoteThread|debug_\w+|dbvm_\w+|dbk_\w+|shellExecute|runCommand|deleteFile|allocateMemory|setMemoryProtection|fullAccess|loadTable|saveTable|createProcess|pause|unpause|registerSymbol|loadstring|dofile)\s*\(/,
    )
  })
})

describe("the pipe client (R1.2, R2.4)", () => {
  it("frames a call and reads its answer", async () => {
    const { b, client } = await fake({ ping: () => ({ success: true, version: BRIDGE_VERSION }) })
    expect(await client.call("ping")).toEqual({ success: true, version: BRIDGE_VERSION })
    expect(b.calls).toEqual([{ method: "ping", params: {} }])
  })

  it("keeps one call in flight, in order, on one connection", async () => {
    const { b, client } = await fake({ echo: (p) => p })
    const answers = await Promise.all([1, 2, 3].map((n) => client.call("echo", { n })))
    expect(answers).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(b.calls.map((c) => c.params.n)).toEqual([1, 2, 3])
    expect(b.connections).toBe(1)
  })

  it("returns the bridge's error as a BridgeError with its code", async () => {
    const { client } = await fake({})
    const e = await client.call("write_memory").catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BridgeError)
    expect((e as BridgeError).code).toBe(-32601)
  })

  it("answers a call the bridge does not answer in time with an error, and goes on", async () => {
    const { b, client } = await fake({ slow: () => 1, fast: () => 2 })
    b.silent.add("slow")
    await expect(client.call("slow", {}, 100)).rejects.toThrow(/did not answer slow within/)
    expect(await client.call("fast")).toBe(2)
  })

  it("drops a call that waited out its timeout behind another, never sending it", async () => {
    const { b, client } = await fake({ slow: () => 1, ping: () => 2 })
    b.silent.add("slow")
    const slow = client.call("slow", {}, 200).catch((e: Error) => e.message)
    await expect(client.call("ping", {}, 50)).rejects.toThrow(/did not answer ping within/)
    await slow
    expect(b.calls.map((c) => c.method)).toEqual(["slow"])
  })

  it("says the bridge is not answering when nothing listens", async () => {
    const client = new BridgeClient({ path: process.platform === "win32" ? "\\\\.\\pipe\\hfr-none" : join(tmpdir(), "none.sock"), timeoutMs: 500 })
    await expect(client.call("ping")).rejects.toThrow(/not answering/)
  })
})

describe("the integration", () => {
  let dir: string
  let exe: string
  let script: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hfr-ce-"))
    mkdirSync(join(dir, "ce", "autorun"), { recursive: true })
    exe = join(dir, "ce", "cheatengine-x86_64.exe")
    writeFileSync(exe, "")
    script = join(dir, BRIDGE_FILE)
    writeFileSync(script, "-- bridge")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const ping = () => ({ success: true, version: BRIDGE_VERSION, cheat_engine: "7.6" })

  describe("checks and status (R1.2, R2.4)", () => {
    it("passes all three when the executable, the installed bridge and its ping are right", async () => {
      const { client } = await fake({ ping })
      writeFileSync(join(dir, "ce", "autorun", BRIDGE_FILE), "-- bridge")
      const ce = cheatEngine({ script, bridge: client })
      const checks = await ce.checks({ executablePath: exe })
      expect(checks.map((c) => [c.name, c.ok])).toEqual([
        ["Cheat Engine executable", true],
        ["Bridge installed", true],
        ["Bridge answers", true],
      ])
      expect(await ce.connected({ executablePath: exe })).toBe(true)
    })

    it("fails each with its fix: no executable, no bridge, no answer", async () => {
      const client = new BridgeClient({ path: process.platform === "win32" ? "\\\\.\\pipe\\hfr-none" : join(tmpdir(), "none.sock"), timeoutMs: 500 })
      const ce = cheatEngine({ script, bridge: client })
      const checks = await ce.checks({ executablePath: join(dir, "missing.exe") })
      expect(checks.every((c) => !c.ok && !!c.fix)).toBe(true)
      expect(await ce.connected({ executablePath: exe })).toBe(false)
    })

    it("fails the install check on a bridge that is not the app's, and the ping check on another version", async () => {
      const { client } = await fake({ ping: () => ({ success: true, version: "12.0.0" }) })
      writeFileSync(join(dir, "ce", "autorun", BRIDGE_FILE), "-- an older bridge")
      const checks = await cheatEngine({ script, bridge: client }).checks({ executablePath: exe })
      expect(checks[1]).toMatchObject({ ok: false, detail: expect.stringMatching(/not the bridge this app carries/) })
      expect(checks[2]).toMatchObject({ ok: false, detail: expect.stringMatching(/12\.0\.0/) })
    })

    it("answers status from the ping and the catalog, reading no process memory", async () => {
      const { b, client } = await fake({ ping })
      const status = await cheatEngine({ script, bridge: client }).call({ executablePath: exe }, "status", {})
      expect(status).toEqual({ connected: true, cheatEngineVersion: "7.6", bridgeVersion: BRIDGE_VERSION, tools: CHEAT_ENGINE_TOOLS.map((t) => t.name) })
      expect(b.calls.map((c) => c.method)).toEqual(["ping"])
    })

    it("answers get_process_list with no target", async () => {
      const { client } = await fake({ get_process_list: () => ({ success: true, count: 1, processes: [{ pid: 7, name: "game.exe" }] }) })
      const r = await cheatEngine({ script, bridge: client }).call({ executablePath: exe }, "get_process_list", {})
      expect(r).toMatchObject({ processes: [{ pid: 7, name: "game.exe" }] })
    })
  })

  describe("installing the bridge (R1.3, R1.4)", () => {
    it("copies the script into the autorun folder", async () => {
      const r = await cheatEngine({ script }).runAction({ executablePath: exe }, "install-bridge")
      expect(r.ok).toBe(true)
      expect(readFileSync(join(dir, "ce", "autorun", BRIDGE_FILE), "utf8")).toBe("-- bridge")
    })

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("shows the script and the folder when it cannot write there", async () => {
      chmodSync(join(dir, "ce", "autorun"), 0o500)
      const r = await cheatEngine({ script }).runAction({ executablePath: exe }, "install-bridge")
      chmodSync(join(dir, "ce", "autorun"), 0o700)
      expect(r.ok).toBe(false)
      expect(r.paths).toEqual([
        { label: "The bridge script", path: script },
        { label: "Copy it into", path: join(dir, "ce", "autorun") },
      ])
    })

    it("shows the script and the folder when the folder is not a folder", async () => {
      rmSync(join(dir, "ce", "autorun"), { recursive: true })
      writeFileSync(join(dir, "ce", "autorun"), "a file where the folder should be")
      const r = await cheatEngine({ script }).runAction({ executablePath: exe }, "install-bridge")
      expect(r.ok).toBe(false)
      expect(r.paths?.map((p) => p.path)).toEqual([script, join(dir, "ce", "autorun")])
    })
  })

  describe("the session on the approved process (R3.1, R3.3, R3.4)", () => {
    /** A bridge whose opened process is `state.opened`, and a host where `state.alive` runs. */
    async function world() {
      const state = { opened: 0, alive: new Set([100, 200]), reads: [] as number[] }
      const { b, client } = await fake({
        open_process: (p) => {
          state.opened = Number(p.process_id_or_name)
          return { success: true, process_id: state.opened, process_name: "game.exe" }
        },
        get_opened_process_id: () => (state.opened ? { success: true, process_id: state.opened } : { success: false, error: "No process attached" }),
        read_memory: (p) => {
          state.reads.push(state.opened)
          return { success: true, address: p.address, data: "90 90" }
        },
        validate_pointer_chains: (p) => ({ success: true, target: p.target }),
      })
      const ce = cheatEngine({
        script,
        bridge: client,
        alive: (pid) => state.alive.has(pid),
        processInfo: async (pid) => (state.alive.has(pid) ? { name: "game", path: "C:\\Games\\game.exe" } : null),
      })
      return { state, b, ce }
    }

    it("describes the process by its name, pid and executable path", async () => {
      const { ce } = await world()
      expect(await ce.describeTarget({ executablePath: exe }, { pid: 100 })).toBe("game (pid 100) — C:\\Games\\game.exe")
      await expect(ce.describeTarget({ executablePath: exe }, { pid: 999 })).rejects.toThrow(/No process with pid 999/)
    })

    it("opens only the approved pid, and calls on it", async () => {
      const { b, ce } = await world()
      const s = await ce.session({ executablePath: exe }, { pid: 100 })
      expect(await s.call("read_memory", { address: "0x10", size: 2 })).toMatchObject({ data: "90 90" })
      expect(b.calls.filter((c) => c.method === "open_process")).toEqual([{ method: "open_process", params: { process_id_or_name: 100 } }])
    })

    it("refuses a call while Cheat Engine has another process open", async () => {
      const { state, b, ce } = await world()
      const s = await ce.session({ executablePath: exe }, { pid: 100 })
      state.opened = 200
      await expect(s.call("read_memory", { address: "0x10" })).rejects.toThrow(/pid 200 open, not the approved pid 100/)
      expect(b.calls.some((c) => c.method === "read_memory")).toBe(false)
    })

    it("answers every call after the process exited with an error saying so, even if the pid comes back", async () => {
      const { state, ce } = await world()
      const s = await ce.session({ executablePath: exe }, { pid: 100 })
      state.alive.delete(100)
      await expect(s.call("read_memory", { address: "0x10" })).rejects.toThrow(/has exited/)
      state.alive.add(100)
      await expect(s.call("read_memory", { address: "0x10" })).rejects.toThrow(/has exited/)
    })

    it("checks the opened process and reads as one unit, so another session cannot open its process in between", async () => {
      const { state, ce } = await world()
      const a = await ce.session({ executablePath: exe }, { pid: 100 })
      const [read] = await Promise.all([a.call("read_memory", { address: "0x10" }), ce.session({ executablePath: exe }, { pid: 200 })])
      expect(read).toMatchObject({ data: "90 90" })
      expect(state.reads).toEqual([100])
      await expect(a.call("read_memory", { address: "0x10" })).rejects.toThrow(/pid 200 open, not the approved pid 100/)
      expect(state.reads).toEqual([100])
    })

    it("refuses to open a process that is not running", async () => {
      const { ce } = await world()
      await expect(ce.session({ executablePath: exe }, { pid: 999 })).rejects.toThrow(/not running/)
    })

    it("passes validate_pointer_chains' target address to the bridge as its target", async () => {
      const { ce } = await world()
      const s = await ce.session({ executablePath: exe }, { pid: 100 })
      expect(await s.call("validate_pointer_chains", { chains: [{ base: "0x1", offsets: [] }], target_address: "0x20" })).toMatchObject({ target: "0x20" })
    })
  })
})
