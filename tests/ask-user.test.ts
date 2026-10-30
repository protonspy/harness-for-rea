import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, describe, expect, it } from "vitest"

/*
  specs/chat R5.2, adr:0008-ask-the-user-from-the-specialist-over-the-run-channel: the MCP server
  baked into the specialist image, run here with the host's Node against a temporary channel folder
  standing in for /run/hfr-ask.
*/

const SERVER = join(import.meta.dirname, "..", "sandbox", "specialist", "ask-user.mjs")

let child: ChildProcessWithoutNullStreams | null = null
afterEach(() => child?.kill())

function start(dir: string) {
  child = spawn(process.execPath, [SERVER, dir, "20"])
  const replies = new Map<number, (v: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as { id: number }
    replies.get(msg.id)?.(msg as unknown as Record<string, unknown>)
  })
  let next = 1
  const call = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++
      replies.set(id, resolve)
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  const notify = (method: string) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  return { call, notify }
}

async function question(dir: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const q = readdirSync(dir).find((f) => /^q-.*\.json$/.test(f))
    if (q) return q
    await new Promise((res) => setTimeout(res, 10))
  }
  throw new Error("no question was written")
}

function answer(dir: string, q: string, body: unknown) {
  const tmp = join(dir, `${q}.tmp`)
  writeFileSync(tmp, JSON.stringify(body))
  renameSync(tmp, join(dir, q.replace(/^q-/, "a-")))
}

describe("the ask-user MCP server (R5.2)", () => {
  it("initializes and lists its one tool", async () => {
    const { call, notify } = start(mkdtempSync(join(tmpdir(), "hfr-ask-")))
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hfr-ask-user" } })
    notify("notifications/initialized")
    const list = (await call("tools/list")).result as { tools: { name: string; inputSchema: { required: string[] } }[] }
    expect(list.tools.map((t) => t.name)).toEqual(["ask_user"])
    expect(list.tools[0].inputSchema.required).toEqual(["prompt", "reason", "kind", "default"])
    expect((await call("nope")).error).toMatchObject({ code: -32601 })
  })

  it("writes the question to the channel and returns the answer the host writes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfr-ask-"))
    const { call } = start(dir)
    const args = { prompt: "Which build?", reason: "They differ.", kind: "choice", choices: ["debug", "release"], default: "debug" }
    const pending = call("tools/call", { name: "ask_user", arguments: args })
    const q = await question(dir)
    expect(JSON.parse(readFileSync(join(dir, q), "utf8"))).toEqual(args)
    answer(dir, q, { answer: "release", origin: "user" })
    const res = (await pending).result as { content: { type: string; text: string }[]; isError?: boolean }
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0].text)).toEqual({ answer: "release", origin: "user" })
  })

  it("returns the host's refusal as a tool error, and refuses an unknown tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hfr-ask-"))
    const { call } = start(dir)
    const pending = call("tools/call", { name: "ask_user", arguments: { prompt: "p", reason: "r", kind: "yesno", default: "maybe" } })
    answer(dir, await question(dir), { error: "a yes/no question's default must be true or false" })
    expect((await pending).result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("true or false") }] })
    expect((await call("tools/call", { name: "rm", arguments: {} })).result).toMatchObject({ isError: true })
  })
})
