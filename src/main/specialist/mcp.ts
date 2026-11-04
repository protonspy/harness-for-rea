import { spawn, type ChildProcess } from "node:child_process"
import { DynamicStructuredTool, type StructuredToolInterface } from "@langchain/core/tools"

/*
  The DeepAgents specialist's MCP client (specs/specialist-providers R2.4, R2.5): one child per server — in the app, a
  `docker exec -i` of the server inside the delegation's container — spoken to over its standard streams in
  newline-delimited JSON-RPC, as the specialist's servers speak it. Only what a client of tools needs: `initialize`,
  `tools/list` and `tools/call`. Each tool becomes a LangChain tool named as Claude Code names it.
*/

export const PROTOCOL_VERSION = "2025-06-18"
/** How long the handshake and the tool list may take; a server that answers neither is not offered. */
export const LIST_TIMEOUT_MS = 60_000
/** Largest tool output handed to the model; the rest is cut and said so. */
export const OUTPUT_CAP = 100_000
/** Largest message a server may write on one line; past it the server is stopped, so the app's memory stays bounded. */
export const LINE_CAP = 16 * 1024 * 1024
/** A tool name a provider's function calling takes, once prefixed. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface Content {
  type?: string
  text?: string
  mimeType?: string
  data?: string
}

export interface McpCallResult {
  content?: Content[]
  isError?: boolean
}

/** What starts a server: a command and its arguments, run with no shell. */
export type StartServer = (command: string, args: string[]) => ChildProcess

const spawnServer: StartServer = (command, args) => spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })

/** The name the model sees: Claude Code's, so the timeline and the prompt read alike on either specialist. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** A tool's result as the text the model reads: its text parts, an image named rather than inlined, cut at the cap. */
export function resultText(r: McpCallResult): string {
  // Cut while joining, so a result of many parts is never held whole twice.
  let text = ""
  let cut = false
  for (const c of Array.isArray(r.content) ? r.content : []) {
    const part = c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? `[image ${c.mimeType ?? ""} omitted]` : `[${c?.type ?? "content"} omitted]`
    text += (text ? "\n" : "") + part.slice(0, OUTPUT_CAP + 1 - text.length)
    if (text.length > OUTPUT_CAP) {
      cut = true
      break
    }
  }
  if (cut) text = `${text.slice(0, OUTPUT_CAP)}\n[output cut at ${OUTPUT_CAP} characters]`
  return r.isError ? `ERROR: ${text || "the tool failed"}` : text
}

export class McpClient {
  private readonly child: ChildProcess
  private next = 1
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }>()
  private stderr = ""
  private ended: Error | null = null

  private constructor(
    readonly server: string,
    child: ChildProcess,
  ) {
    this.child = child
    child.stdin?.on("error", () => undefined)
    child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-2000)
    })
    // Lines split by hand with a cap: a server that writes without end is stopped rather than held in memory.
    let buffer = ""
    child.stdout?.on("data", (c: Buffer) => {
      buffer += c.toString("utf8")
      let at: number
      while ((at = buffer.indexOf("\n")) >= 0) {
        this.line(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
      if (buffer.length > LINE_CAP) {
        buffer = ""
        this.stderr += `\nwrote a message over ${LINE_CAP / 1024 / 1024} MB`
        child.kill()
      }
    })
    const end = (why: string) => {
      this.ended ??= new Error(`MCP server ${server} ${why}${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`)
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(this.ended)
        this.pending.delete(id)
      }
    }
    child.on("error", (e) => end(`did not start (${e.message})`))
    child.on("close", (code) => end(`exited (${code})`))
  }

  /** Start a server and complete the handshake; throws when it does not answer. */
  static async start(server: string, command: string, args: string[], start: StartServer = spawnServer): Promise<McpClient> {
    const c = new McpClient(server, start(command, args))
    try {
      await c.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "harness-for-rea", version: "1" } },
        LIST_TIMEOUT_MS,
      )
      c.notify("notifications/initialized")
      return c
    } catch (e) {
      c.close()
      throw e
    }
  }

  private line(raw: string) {
    const line = raw.replace(/^\uFEFF/, "").trim()
    if (!line) return
    let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    // A request from the server is never taken for an answer to one of ours: a ping is answered, anything else refused.
    if (typeof msg?.method === "string") {
      if (msg.id === undefined || msg.id === null) return
      if (msg.method === "ping") this.write({ id: msg.id, result: {} })
      else this.write({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
      return
    }
    if (typeof msg?.id !== "number") return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP error")))
    else p.resolve(msg.result)
  }

  private write(msg: object) {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
  }

  private notify(method: string, params?: object) {
    this.write({ method, ...(params ? { params } : {}) })
  }

  /** One request; `timeoutMs` 0 waits as long as the server takes. */
  request(method: string, params: object, timeoutMs = 0): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended)
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`MCP server ${this.server} did not answer ${method}.`))
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  /** Every tool the server offers, page by page. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, LIST_TIMEOUT_MS)) as { tools?: McpTool[]; nextCursor?: string }
      tools.push(...(r?.tools ?? []).filter((t) => typeof t?.name === "string"))
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 0): Promise<McpCallResult> {
    return ((await this.request("tools/call", { name, arguments: args }, timeoutMs)) ?? {}) as McpCallResult
  }

  /** The server's tools as LangChain tools; a failed call reads as an `ERROR:` result, never a thrown error. */
  async tools(timeoutMs = 0): Promise<StructuredToolInterface[]> {
    // A name a provider would refuse fails every model call, and a second tool of one name shadows the first: both are left out.
    const seen = new Set<string>()
    const usable = (await this.listTools()).filter((t) => {
      const name = mcpToolName(this.server, t.name)
      if (!TOOL_NAME.test(name) || seen.has(name)) return false
      seen.add(name)
      return true
    })
    return usable.map(
      (t) =>
        new DynamicStructuredTool({
          name: mcpToolName(this.server, t.name),
          description: t.description ?? t.name,
          schema: (t.inputSchema ?? { type: "object", properties: {} }) as never,
          func: async (input: unknown) => {
            try {
              return resultText(await this.call(t.name, (input ?? {}) as Record<string, unknown>, timeoutMs))
            } catch (e) {
              return `ERROR: ${(e as Error).message}`
            }
          },
        }),
    )
  }

  /** End the server's input, which ends a well-behaved server; one that stays is killed. */
  close() {
    this.child.stdin?.end()
    const late = setTimeout(() => this.child.kill(), 5_000)
    late.unref?.()
    this.child.once("close", () => clearTimeout(late))
  }
}
