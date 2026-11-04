import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { McpClient, mcpToolName, OUTPUT_CAP, resultText } from "../src/main/specialist/mcp"

/* The DeepAgents specialist's MCP client over a server's standard streams (specs/specialist-providers R2.4, R2.5). */

const FAKE = join(__dirname, "fixtures", "fake-mcp.mjs")
const open: McpClient[] = []
const start = async (server = "rea") => {
  const c = await McpClient.start(server, process.execPath, [FAKE])
  open.push(c)
  return c
}
afterEach(() => {
  for (const c of open.splice(0)) c.close()
})

describe("specialist MCP client", () => {
  it("lists every page of a server's tools after the handshake", async () => {
    const c = await start()
    expect((await c.listTools()).map((t) => t.name)).toEqual(["echo", "fail", "picture", "hang"])
  })

  it("names each tool as Claude Code does, and calls it with the model's arguments", async () => {
    const tools = await (await start("hfr")).tools()
    expect(tools.map((t) => t.name)).toEqual(["mcp__hfr__echo", "mcp__hfr__fail", "mcp__hfr__picture", "mcp__hfr__hang"])
    expect(await tools[0].invoke({ text: "hi" })).toBe("echo: hi")
    expect(mcpToolName("cheat-engine", "read_memory")).toBe("mcp__cheat-engine__read_memory")
  })

  it("reads a failed call as an ERROR result the model can act on, and names an image instead of inlining it", async () => {
    const tools = await (await start()).tools()
    expect(await tools[1].invoke({})).toBe("ERROR: no such address")
    expect(await tools[2].invoke({})).toBe("a shot\n[image image/png omitted]")
  })

  it("answers a call that outlives its timeout, or a server that exits, with an error instead of waiting", async () => {
    const c = await start()
    const hang = (await c.tools(200))[3]
    expect(await hang.invoke({})).toMatch(/^ERROR: MCP server rea did not answer tools\/call/)
    const waiting = c.call("hang", {})
    c.close()
    await expect(waiting).rejects.toThrow(/MCP server rea exited/)
  })

  it("refuses a server that does not start", async () => {
    await expect(McpClient.start("rea", join(__dirname, "no-such-binary"), [])).rejects.toThrow(/MCP server rea/)
  })

  it("cuts an output past the cap and says so", () => {
    const text = resultText({ content: [{ type: "text", text: "x".repeat(OUTPUT_CAP + 10) }] })
    expect(text.length).toBeLessThan(OUTPUT_CAP + 100)
    expect(text).toMatch(/output cut at/)
  })
})
