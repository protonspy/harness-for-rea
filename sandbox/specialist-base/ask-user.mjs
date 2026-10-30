// The specialist's way to ask the user a question (specs/chat R5.2,
// adr:0008-ask-the-user-from-the-specialist-over-the-run-channel): a stdio MCP server with one tool,
// `ask_user`, that writes the question into the run's ask channel and waits for the host to write
// the answer beside it. No network, no other channel; no dependency beyond Node itself.
//
//   node ask-user.mjs <channel dir> [poll ms]
//
// A question is q-<id>.json; the host answers with a-<id>.json, either {answer, origin} or {error}.
import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const dir = process.argv[2] ?? "/run/hfr-ask"
const pollMs = Number(process.argv[3] ?? 250)

const TOOL = {
  name: "ask_user",
  description: [
    "Ask the user one question and wait for the answer. Use it only when a fact only the user knows changes your analysis, never to ask for authorization or purpose.",
    "Give the reason and a default that fits the kind; the default is used if the user does not answer in time.",
    'Returns {"answer", "origin"}; origin is "user", or "timeout"/"cap"/"stopped" when the default was used.',
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The question, as the user will read it." },
      reason: { type: "string", description: "Why the answer is needed now and what it changes." },
      kind: { type: "string", enum: ["choice", "yesno", "number", "text"] },
      choices: { type: "array", items: { type: "string" }, description: "The options, for kind choice only." },
      default: { type: ["string", "number", "boolean"], description: "Used if the user does not answer in time." },
    },
    required: ["prompt", "reason", "kind", "default"],
    additionalProperties: false,
  },
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

async function ask(args) {
  const id = randomUUID()
  const tmp = join(dir, `.q-${id}.tmp`)
  writeFileSync(tmp, JSON.stringify(args ?? {}))
  renameSync(tmp, join(dir, `q-${id}.json`))
  const answer = join(dir, `a-${id}.json`)
  for (;;) {
    let body = null
    try {
      body = JSON.parse(readFileSync(answer, "utf8"))
    } catch {
      body = null
    }
    if (body) {
      rmSync(answer, { force: true })
      return body.error ? text(String(body.error), true) : text(JSON.stringify({ answer: body.answer, origin: body.origin }))
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
      result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hfr-ask-user", version: "1" } },
    })
  if (method === "ping") return send({ id, result: {} })
  if (method === "tools/list") return send({ id, result: { tools: [TOOL] } })
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return send({ id, result: text(`Unknown tool ${String(params?.name)}.`, true) })
    return send({ id, result: await ask(params.arguments) })
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
  // Each call waits on the user on its own, so one question never holds up another message.
  void handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }))
}
