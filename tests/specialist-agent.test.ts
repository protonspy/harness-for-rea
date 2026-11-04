import { DynamicStructuredTool } from "@langchain/core/tools"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { makeModel } from "../src/main/orchestrator/model"
import type { ExecBuffer } from "../src/main/sandbox/taskbox"
import { AgentSpecialist, agentFilesOf, classifyAgentFailure } from "../src/main/specialist/agent"
import { ContainerBackend } from "../src/main/specialist/container"
import type { StreamEvent } from "../src/main/specialist/stream"

/* The specialist as a DeepAgents agent on the host (specs/specialist-providers R1.2, R2.1, R2.2, R2.5–R2.8). */

type Body = { model: string; stream?: boolean; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
type Reply = { content?: string; tool_calls?: { name: string; args: unknown }[] } | "hang" | { status: number }

let script: Reply[] = []
let requests: Body[] = []
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body
    requests.push(body)
    const r = script.shift()
    if (!r) throw new Error("The script ran out of replies")
    if (r === "hang")
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))
    if ("status" in r) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: r.status, headers: { "content-type": "application/json" } })
    let n = 0
    const tool_calls = r.tool_calls?.map((t) => ({ id: `call_${requests.length}_${n++}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }))
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    if (body.stream) {
      const chunk = (o: object) => `data: ${JSON.stringify({ id: "g", object: "chat.completion.chunk", created: 0, model: body.model, ...o })}\n\n`
      return new Response(
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: r.content ?? null, ...(tool_calls ? { tool_calls: tool_calls.map((t, index) => ({ index, ...t })) } : {}) }, finish_reason: null }] }) +
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: tool_calls ? "tool_calls" : "stop" }] }) +
          chunk({ choices: [], usage }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response(
      JSON.stringify({ id: "g", model: body.model, choices: [{ message: { role: "assistant", content: r.content ?? null, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage }),
      { headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

let docker: string[][] = []
const exec: ExecBuffer = async (args) => {
  docker.push(args)
  return { code: 0, stdout: Buffer.from("ELF 64-bit LSB executable\n"), stderr: "" }
}
let reaCalls: unknown[] = []
const rea = new DynamicStructuredTool({
  name: "mcp__rea__inspect_artifact",
  description: "Inspect an artifact",
  schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
  func: async (input: unknown) => (reaCalls.push(input), "format: ELF"),
})

function specialist(o: { idleMs?: number; signal?: AbortSignal } = {}) {
  const events: StreamEvent[] = []
  let disposed = 0
  const s = new AgentSpecialist({
    model: (onUsage) => makeModel({ provider: "hopper", apiKey: "sk_hopper_test", model: "deepseek-v4.1-flash-1017-abliterated", onUsage }),
    provider: "Hopper",
    modelName: "deepseek-v4.1-flash-1017-abliterated",
    backend: new ContainerBackend(exec, "hfr-1234"),
    tools: [rea],
    systemPrompt: "You are the specialist. Use Bash.",
    idleMs: o.idleMs ?? 60_000,
    signal: o.signal,
    onEvent: (e) => events.push(e),
    dispose: async () => void disposed++,
  })
  return { s, events, disposed: () => disposed }
}

beforeEach(() => {
  script = []
  requests = []
  docker = []
  reaCalls = []
})

describe("the DeepAgents specialist", () => {
  it("runs its shell in the container and answers, recording Claude Code's events and the turn's usage (R2.1, R2.2, R2.6)", async () => {
    script = [{ tool_calls: [{ name: "execute", args: { command: "file /work/a.bin" } }] }, { content: "The file is an ELF executable." }]
    const { s, events } = specialist()
    const r = await s.send("Map /work/a.bin")
    expect(r).toMatchObject({ text: "The file is an ELF executable.", error: false, tokensIn: 200, tokensOut: 40 })
    expect(docker).toEqual([["exec", "-w", "/work", "hfr-1234", "timeout", "-s", "KILL", "600", "sh", "-c", "file /work/a.bin"]])
    expect(events.map((e) => e.kind)).toEqual(["init", "tool.call", "tool.result", "text", "result"])
    const call = events.find((e) => e.kind === "tool.call")!
    expect(call.payload).toMatchObject({ tool: "execute", callId: expect.stringMatching(/^call_/) })
    expect(events.find((e) => e.kind === "tool.result")!.payload).toMatchObject({ tool: "execute", callId: call.payload.callId, output: expect.stringContaining("ELF") })
    expect(events.at(-1)!.payload).toMatchObject({ tokensIn: 200, tokensOut: 40, output: "The file is an ELF executable." })
    // the prompt Claude Code gets, and how this run's tools are named
    const system = requests[0].messages.find((m) => m.role === "system")
    expect(JSON.stringify(system?.content)).toMatch(/You are the specialist[\s\S]*Your shell is the `execute` tool/)
    await s.close()
  })

  it("offers its MCP tools by Claude Code's names and no subagent tool, and records the files they read (R2.5)", async () => {
    script = [{ tool_calls: [{ name: "mcp__rea__inspect_artifact", args: { path: "/work/a.bin" } }] }, { content: "done" }]
    const { s, events } = specialist()
    await s.send("x")
    const offered = (requests[0].tools ?? []).map((t) => t.function.name)
    expect(offered).toContain("mcp__rea__inspect_artifact")
    expect(offered).toContain("execute")
    expect(offered).not.toContain("task")
    expect(reaCalls).toEqual([{ path: "/work/a.bin" }])
    expect(events.find((e) => e.kind === "tool.call")!.payload.files).toEqual([{ path: "a.bin", op: "read" }])
  })

  it("keeps the thread across turns, so a correction sees the report it corrects", async () => {
    script = [{ content: "first report" }, { content: "corrected report" }]
    const { s } = specialist()
    await s.send("analyse")
    expect((await s.send("fix the contract")).text).toBe("corrected report")
    expect(JSON.stringify(requests[1].messages)).toContain("first report")
  })

  it("names the provider when it refuses the key or limits the rate (R2.8)", async () => {
    script = [{ status: 401 }]
    await expect(specialist().s.send("x")).rejects.toMatchObject({ kind: "auth", message: expect.stringMatching(/^Hopper refused the specialist's API key/) })
    expect(classifyAgentFailure(Object.assign(new Error("Too many"), { status: 429 }), "Hopper")).toMatchObject({ kind: "limit", message: expect.stringMatching(/^Hopper/) })
    expect(classifyAgentFailure(Object.assign(new Error("quota"), { status: 402 }), "Hopper").kind).toBe("limit")
  })

  it("stops a turn with no model or tool call for the inactivity timeout, and lets go of what it holds (R2.7)", async () => {
    script = ["hang"]
    const { s, disposed } = specialist({ idleMs: 300 })
    await expect(s.send("x")).rejects.toMatchObject({ kind: "timeout" })
    expect(s.outcome).toBe("timeout")
    expect(disposed()).toBe(1)
    await s.close()
    expect(disposed()).toBe(1)
  })

  it("is cancelled with the delegation's signal", async () => {
    script = ["hang"]
    const ac = new AbortController()
    const { s } = specialist({ signal: ac.signal })
    const turn = s.send("x")
    setTimeout(() => ac.abort(), 100)
    await expect(turn).rejects.toMatchObject({ kind: "cancelled" })
  })

  it("reads the files of DeepAgents' file tools as Claude Code's are read", () => {
    expect(agentFilesOf("read_file", { file_path: "/work/src/a.c" })).toEqual([{ path: "src/a.c", op: "read" }])
    expect(agentFilesOf("edit_file", { file_path: "/work/src/a.c" })).toEqual([{ path: "src/a.c", op: "write" }])
    expect(agentFilesOf("execute", { command: "ls" })).toEqual([])
  })
})
