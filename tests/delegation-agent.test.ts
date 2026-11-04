import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { Settings } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { delegate, DelegationRefused, type Launcher } from "../src/main/delegation"
import { EventLog } from "../src/main/events/log"
import type { ExecBuffer } from "../src/main/sandbox/taskbox"

/* A delegation on a provider: the DeepAgents specialist here, its tools and MCP servers in the container (specs/specialist-providers R1.2, R2.1, R2.3, R2.4). */

const FAKE_MCP = join(import.meta.dirname, "fixtures", "fake-mcp.mjs")
const realFetch = globalThis.fetch
let fetched: { url: string; auth: string; model: string; tools: string[] }[] = []
let replies: { content?: string; tool_calls?: { name: string; args: unknown }[] }[] = []

beforeAll(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; tools?: { function: { name: string } }[] }
    fetched.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization") ?? "",
      model: body.model,
      tools: (body.tools ?? []).map((t) => t.function.name),
    })
    const r = replies.shift() ?? { content: "The file exports a constant." }
    const tool_calls = r.tool_calls?.map((t, i) => ({
      id: `call_${fetched.length}_${i}`,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }))
    return new Response(
      JSON.stringify({
        id: "g",
        model: body.model,
        choices: [{ message: { role: "assistant", content: r.content ?? null, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

let base = ""
let root = ""
let data = ""
let log: EventLog
let taskId = ""
let settings: Settings
let containers: { mode: string; box?: string }[]
let stops = 0
let servers: string[][]
let docker: string[][]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-agent-"))
  root = join(base, "repo")
  data = join(base, "data")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  openDb(join(data, "hfr.db"))
  log = new EventLog(data)
  taskId = log.createTask({ request: "r", sourceRoot: root, model: "m" }).id
  settings = {
    ...DEFAULT_SETTINGS,
    specialistProvider: "custom",
    specialistModel: "my-model",
    baseUrls: { custom: "https://llm.example/v1" },
    timeoutMinutes: 1,
  }
  containers = []
  stops = 0
  servers = []
  docker = []
  fetched = []
  replies = []
})
afterEach(() => {
  closeDb()
  rmSync(base, { recursive: true, force: true })
})

const launcher: Launcher = {
  preflight: async () => null,
  launch: () => {
    throw new Error("Claude Code is not launched on a provider")
  },
  container: async (_ws, mode, box) => {
    containers.push({ mode, ...(box ? { box } : {}) })
    return { name: "hfr-agent", stop: async () => void stops++ }
  },
}
const exec: ExecBuffer = async (args) => {
  docker.push(args)
  return { code: 0, stdout: Buffer.from("ok\n"), stderr: "" }
}
const deps = (apiKey: string | null = "sk-test") => ({
  log,
  dataDir: data,
  launcher,
  settings: () => settings,
  apiKey: () => apiKey,
  agent: {
    exec,
    startServer: (command: string, args: string[]) => {
      servers.push([command, ...args])
      return spawn(process.execPath, [FAKE_MCP], { stdio: ["pipe", "pipe", "pipe"] })
    },
  },
})
const pkg = () => ContextPackageSchema.parse({ brief: "b", objective: "Look at /work/src/a.ts", files: ["src/a.ts"] })

describe("a delegation on a provider", () => {
  it("runs the agent on the provider's model and key, its shell and MCP servers in its own container, removed at the end", async () => {
    replies = [{ tool_calls: [{ name: "execute", args: { command: "cat /work/src/a.ts" } }] }]
    const r = await delegate(deps(), { taskId, sourceRoot: root, pkg: pkg() })
    expect(r.report).toBe("The file exports a constant.")
    // R1.2: the provider's endpoint, key and the specialist's model
    expect(fetched[0]).toMatchObject({ url: "https://llm.example/v1/chat/completions", auth: "Bearer sk-test", model: "my-model" })
    // R2.4: the servers Claude Code gets, each started inside the container, their tools by Claude Code's names
    expect(servers.map((s) => s.slice(0, 5))).toEqual([
      ["docker", "exec", "-i", "-w", "/work"],
      ["docker", "exec", "-i", "-w", "/work"],
    ])
    expect(servers.every((s) => s.includes("hfr-agent"))).toBe(true)
    expect(fetched[0].tools).toEqual(expect.arrayContaining(["mcp__hfr__echo", "mcp__rea__echo", "execute"]))
    // R2.2, R2.3: the command ran in the container, which was the delegation's own, read-only, and is gone
    expect(docker[0]).toEqual(expect.arrayContaining(["exec", "hfr-agent", "cat /work/src/a.ts"]))
    expect(containers).toEqual([{ mode: "read" }])
    expect(stops).toBe(1)
    const kinds = log.history(taskId).events.map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(["specialist.init", "specialist.tool.call", "specialist.tool.result", "specialist.result"]))
  })

  it("refuses before any container when the provider's key is not set", async () => {
    settings = { ...settings, specialistProvider: "hopper", specialistModel: "deepseek-v4.1-flash-1017-abliterated" }
    await expect(delegate(deps(null), { taskId, sourceRoot: root, pkg: pkg() })).rejects.toThrow(DelegationRefused)
    await expect(delegate(deps(null), { taskId, sourceRoot: root, pkg: pkg() })).rejects.toThrow(/Set your Hopper API key/)
    expect(containers).toEqual([])
  })

  it("refuses an OpenAI-compatible specialist with no base URL", async () => {
    settings = { ...settings, baseUrls: {} }
    await expect(delegate(deps(), { taskId, sourceRoot: root, pkg: pkg() })).rejects.toThrow(/Set the base URL of your OpenAI-compatible/)
    expect(containers).toEqual([])
  })

  it("refuses when no model is chosen for the specialist", async () => {
    settings = { ...settings, specialistModel: " " }
    await expect(delegate(deps(), { taskId, sourceRoot: root, pkg: pkg() })).rejects.toThrow(/Choose the specialist's model/)
  })
})
