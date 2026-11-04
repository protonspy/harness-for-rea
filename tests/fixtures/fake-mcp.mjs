// A stdio MCP server for the specialist's MCP client tests: two pages of tools, an echo, a failing tool, an image, a
// tool that never answers, and a byte-order mark and noise on stdout as a careless server might write.
import { createInterface } from "node:readline"

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
const pages = [
  {
    tools: [{ name: "echo", description: "Echo the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    nextCursor: "2",
  },
  { tools: [{ name: "fail" }, { name: "picture" }, { name: "hang" }] },
]
process.stdout.write("not json\n")
for await (const raw of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(raw.replace(/^﻿/, ""))
  const { id, method, params } = msg
  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" } } })
  else if (method === "notifications/initialized") process.stderr.write("initialized\n")
  else if (method === "tools/list") send({ id, result: pages[params?.cursor === "2" ? 1 : 0] })
  else if (method === "tools/call") {
    const { name, arguments: args } = params
    if (name === "echo")
      process.stdout.write(`﻿${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${args.text}` }] } })}\n`)
    else if (name === "fail") send({ id, result: { content: [{ type: "text", text: "no such address" }], isError: true } })
    else if (name === "picture")
      send({
        id,
        result: {
          content: [
            { type: "text", text: "a shot" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
        },
      })
    else if (name === "hang") continue
    else send({ id, error: { code: -32602, message: `Unknown tool ${name}` } })
  } else send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
}
