// One MCP integration's server inside the specialist's container (specs/mcp-integrations R4.1, R4.2,
// adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations): a stdio MCP server whose tools are the ones the
// app wrote for this delegation, each call carried to the app as a file over the run's ask channel. No network, no
// other channel, no dependency beyond Node itself; the app checks every call before the engine sees it.
//
//   node server.mjs <integration id> [tools dir] [channel dir] [poll ms]
//
// tools/list is <tools dir>/<id>.json; a call is t-<id>.json, {integration, tool, arguments}; the app answers with
// r-<id>.json, {result} or {error}.
import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const integration = process.argv[2] ?? ""
const toolsDir = process.argv[3] ?? "/run/hfr/mcp"
const dir = process.argv[4] ?? "/run/hfr-ask"
const pollMs = Number(process.argv[5] ?? 100)

const tools = (() => {
  try {
    return JSON.parse(readFileSync(join(toolsDir, `${integration}.json`), "utf8")).tools ?? []
  } catch {
    return []
  }
})()
const names = new Set(tools.map((t) => t.name))

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

async function call(tool, args) {
  const id = randomUUID()
  const tmp = join(dir, `.t-${id}.tmp`)
  writeFileSync(tmp, JSON.stringify({ integration, tool, arguments: args ?? {} }))
  renameSync(tmp, join(dir, `t-${id}.json`))
  const answer = join(dir, `r-${id}.json`)
  for (;;) {
    let body = null
    try {
      body = JSON.parse(readFileSync(answer, "utf8"))
    } catch {
      body = null
    }
    if (body) {
      rmSync(answer, { force: true })
      return "error" in body ? text(String(body.error), true) : text(JSON.stringify(body.result ?? null))
    }
    await new Promise((res) => setTimeout(res, pollMs))
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // a notification
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `hfr-${integration}`, version: "1" },
      },
    })
  if (method === "ping") return send({ id, result: {} })
  if (method === "tools/list") return send({ id, result: { tools } })
  if (method === "tools/call") {
    if (!names.has(params?.name)) return send({ id, result: text(`Unknown tool ${String(params?.name)}.`, true) })
    return send({ id, result: await call(params.name, params.arguments) })
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
}

for await (const raw of createInterface({ input: process.stdin })) {
  const line = raw.replace(/^﻿/, "")
  if (!line.trim()) continue
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } })
    continue
  }
  // Each call waits on the app on its own, so a slow scan never holds up another message.
  void handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }))
}
