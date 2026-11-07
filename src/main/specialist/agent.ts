import { randomUUID } from "node:crypto"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { MemorySaver } from "@langchain/langgraph"
import { createDeepAgent, type BaseSandbox } from "deepagents"
import { todoListMiddleware } from "langchain"
import { PROVIDERS, type ModelProtocol, type ProviderId } from "@shared/providers"
import type { FileTouch, OrchestratorEffort, SpecialistEffort } from "@shared/types"
import { toolPolicy } from "../orchestrator/agent"
import { makeModel, type ModelUsage } from "../orchestrator/model"
import type { CacheHypothesis, CostStatus, ModelRateSnapshot } from "@shared/pricing"
import { MCP_TOOL_TIMEOUT_MS, mcpExecArgs, type McpServer } from "../sandbox/docker"
import type { ExecBuffer } from "../sandbox/taskbox"
import { ContainerBackend } from "./container"
import { SpecialistError, type FailureKind, type Specialist } from "./executor"
import { McpClient, type StartServer } from "./mcp"
import { ARGS_CAP, clean, filesOf, fromWork, RESULT_CAP, TEXT_CAP, type StreamEvent, type StreamResult } from "./stream"

/*
  The specialist on a provider's model (specs/specialist-providers R2, adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent):
  a DeepAgents agent in the app's process, one turn per `send` on one thread so a contract correction sees the report
  it corrects. Its file tools and shell are the delegation's container's, through the backend it is given, and its MCP
  tools the servers in that container. Its callbacks become the events Claude Code's stream yields, so the delegation
  records both alike.
*/

/** DeepAgents' own tools the specialist keeps; its subagent tool is not among them (R2.5). */
export const AGENT_TOOLS = ["ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute", "write_todos"]

/** Turns a single answer may take, far past any analysis, so a loop that never ends still does. */
export const RECURSION_LIMIT = 10_000

/** Appended to the prompt Claude Code reads, which names Claude Code's tools. */
export const AGENT_TOOLS_NOTE = [
  "",
  "## Your tools in this run",
  "",
  "Your shell is the `execute` tool: wherever these instructions say Bash, use `execute`. Your file tools are `ls`, `read_file`, `glob`, `grep`, `write_file` and `edit_file`, on absolute paths in the container (`/work/...`). Every command and file tool runs inside the sandbox, never on the user's machine.",
].join("\n")

const READS = new Set(["read_file", "ls", "glob", "grep"])
const WRITES = new Set(["write_file", "edit_file"])

/** The files an agent's tool call reads or writes, by source-relative path, as Claude Code's are read (R2.6). */
export function agentFilesOf(tool: string, input: Record<string, unknown>): FileTouch[] {
  if (tool.startsWith("mcp__")) return filesOf(tool, input)
  const op = WRITES.has(tool) ? "write" : READS.has(tool) ? "read" : null
  const p = input.file_path ?? input.path
  return op && typeof p === "string" && p ? [{ path: fromWork(clean(p)), op }] : []
}

/** What an API error says to the user, the provider named (R2.8). */
export function classifyAgentFailure(e: unknown, provider: string): SpecialistError {
  const err = e as { status?: unknown; statusCode?: unknown; cause?: { status?: unknown } }
  const text = clean((e as Error)?.message ?? e).slice(0, 400)
  // The client's status, or the one LangChain leaves at the start of its message.
  const status = err?.statusCode ?? err?.status ?? err?.cause?.status ?? Number(/^(\d{3}) /.exec(text)?.[1])
  if (status === 401 || /invalid api key|unauthori[sz]ed|incorrect api key/i.test(text))
    return new SpecialistError("auth", `${provider} refused the specialist's API key. Set a valid key in Settings.`)
  if (status === 403 || /forbidden|permission denied|access denied/i.test(text))
    return new SpecialistError("auth", `Your ${provider} account does not have access or permissions for this endpoint or model.`)
  if (status === 402 || /insufficient[_ ]quota|insufficient credits|credit quota/i.test(text))
    return new SpecialistError("limit", `${provider} has no credit left for the specialist. Add credit to your ${provider} account.`)
  if (status === 429 || /rate.?limit/i.test(text))
    return new SpecialistError("limit", `${provider} is limiting the specialist's requests for now. Try again shortly.`)
  return new SpecialistError("failed", `${provider}: ${text || "the specialist's model failed."}`)
}

function textOf(m: BaseMessage | undefined): string {
  const c = m?.content
  if (typeof c === "string") return c
  return Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("") : ""
}

function cut(text: string, limit: number) {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

export interface AgentSpecialistOptions {
  /** the provider's chat model, built with the usage callback the session counts each call with */
  model(onUsage: (u: ModelUsage) => void): BaseChatModel
  /** the provider's label and the chosen model, for the events and the failures */
  provider: string
  modelName: string
  backend: BaseSandbox
  /** the MCP servers' tools, named `mcp__<server>__<tool>` */
  tools: StructuredToolInterface[]
  systemPrompt: string
  /** the inactivity timeout (R2.7): no model call or tool call for this long stops the turn */
  idleMs: number
  /** how long one tool call may stay open, Claude Code's own MCP timeout */
  openCeilingMs?: number
  signal?: AbortSignal
  onEvent?(e: StreamEvent): void
  /** stops what the run holds — its MCP servers and its own container — once */
  dispose?(): Promise<void>
  /** what the init event says went wrong starting the run, such as a server that did not start */
  notice?: string
}

/** The specialist's effort as the orchestrator's reasoning effort, which the provider's model takes (R1.2). */
export function agentEffort(effort: SpecialistEffort): OrchestratorEffort {
  return effort as OrchestratorEffort
}

/** Where the agent runs and on what: the container its tools use, and the provider's endpoint, key and model. */
export interface AgentRun {
  container: { name: string; stop(): Promise<void> }
  /** `docker` with its arguments, for the backend's calls */
  exec: ExecBuffer
  servers: Record<string, McpServer>
  /** starts one MCP server's `docker exec -i`; spawns `docker` in the app */
  startServer?: StartServer
  provider: ProviderId
  baseUrl: string
  apiKey: string
  model: string
  effort: SpecialistEffort
  protocol?: ModelProtocol
}

/**
  Start the agent for one delegation (R2.1–R2.4): each MCP server inside the container — one that does not start is
  left out and named in the init event, as Claude Code goes on without it — and the agent on the provider's model. What
  it holds is let go when it closes: the servers, then the container.
*/
export async function startAgentSpecialist(
  run: AgentRun,
  o: Omit<AgentSpecialistOptions, "model" | "provider" | "modelName" | "backend" | "tools" | "dispose">,
): Promise<AgentSpecialist> {
  const clients: McpClient[] = []
  const failed: string[] = []
  const tools: StructuredToolInterface[] = []
  const stop = async () => {
    for (const c of clients) c.close()
    await run.container.stop()
  }
  try {
    // All at once, so one slow server holds up the start by its own handshake only; their tools in the servers' order.
    const started = await Promise.all(
      Object.entries(run.servers).map(async ([name, server]) => {
        let client: McpClient | null = null
        try {
          client = await McpClient.start(name, "docker", mcpExecArgs(run.container.name, server), run.startServer)
          clients.push(client)
          return { tools: await client.tools(MCP_TOOL_TIMEOUT_MS) }
        } catch (e) {
          return { tools: [], error: `${name}: ${(e as Error).message}` }
        }
      }),
    )
    for (const s of started) {
      tools.push(...s.tools)
      if (s.error) failed.push(s.error)
    }
    if (o.signal?.aborted) throw new SpecialistError("cancelled", "Cancelled.")
    const label = PROVIDERS[run.provider].label
    const s = new AgentSpecialist({
      ...o,
      model: (onUsage) =>
        makeModel({
          provider: run.provider,
          baseUrl: run.baseUrl,
          apiKey: run.apiKey,
          model: run.model,
          effort: agentEffort(run.effort),
          protocol: run.protocol,
          onUsage,
        }),
      provider: label,
      modelName: run.model,
      backend: new ContainerBackend(run.exec, run.container.name),
      tools,
      dispose: stop,
      ...(failed.length ? { notice: `MCP servers that did not start: ${failed.join("; ")}` } : {}),
    })
    return s
  } catch (e) {
    await stop().catch(() => undefined)
    throw e
  }
}

export class AgentSpecialist implements Specialist {
  private readonly agent: ReturnType<typeof createDeepAgent>
  private readonly thread = randomUUID()
  private readonly o: AgentSpecialistOptions
  private failure: SpecialistError | null = null
  private turn: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly open = new Set<string>()
  private usage = {
    tokensIn: 0,
    tokensOut: 0,
    cacheTokens: 0,
    costUsd: 0,
    costStatus: "unknown" as CostStatus,
    estimate: false,
    model: "",
    rateSnapshot: undefined as ModelRateSnapshot | undefined,
    cacheHypothesis: undefined as CacheHypothesis | undefined,
  }
  private started = false
  private disposed: Promise<void> | null = null
  private readonly abort = () => void this.kill("cancelled")

  constructor(o: AgentSpecialistOptions) {
    if (o.signal?.aborted) throw new SpecialistError("cancelled", "Cancelled.")
    this.o = o
    const model = o.model((u) => {
      this.usage.tokensIn += u.tokensIn
      this.usage.tokensOut += u.tokensOut
      this.usage.cacheTokens += u.cacheTokens ?? 0
      this.usage.costUsd += u.costUsd
      this.usage.model = u.model
      if (u.costStatus === "reported" || (u.costStatus === "estimated" && this.usage.costStatus !== "reported")) {
        this.usage.costStatus = u.costStatus
      }
      this.usage.estimate = this.usage.estimate || u.estimate
      if (u.rateSnapshot) this.usage.rateSnapshot = u.rateSnapshot
      if (u.cacheHypothesis) this.usage.cacheHypothesis = u.cacheHypothesis
    })
    this.agent = createDeepAgent({
      model,
      systemPrompt: o.systemPrompt + AGENT_TOOLS_NOTE,
      tools: o.tools,
      middleware: [todoListMiddleware(), toolPolicy(new Set([...AGENT_TOOLS, ...o.tools.map((t) => t.name)]), "the specialist")],
      backend: o.backend,
      checkpointer: new MemorySaver(),
    })
    o.signal?.addEventListener("abort", this.abort, { once: true })
  }

  get outcome(): FailureKind | null {
    return this.failure?.kind ?? null
  }

  private emit(e: StreamEvent) {
    this.o.onEvent?.(e)
  }

  /** Restarts the inactivity timer at every sign of life; with a tool call open, the ceiling instead (R2.7). */
  private arm() {
    this.disarm()
    if (!this.turn || this.failure) return
    const ceiling = this.o.openCeilingMs ?? MCP_TOOL_TIMEOUT_MS
    this.timer = setTimeout(() => void this.kill("timeout"), this.open.size ? ceiling : this.o.idleMs)
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private callbacks() {
    const calls = new Map<string, { tool: string; callId: string }>()
    const end = (runId: string, output: unknown, error?: unknown) => {
      const { tool, callId } = calls.get(runId) ?? { tool: "tool", callId: runId }
      calls.delete(runId)
      this.open.delete(runId)
      const raw =
        error !== undefined
          ? clean((error as Error)?.message ?? error)
          : clean(typeof output === "string" ? output : ((output as { content?: unknown })?.content ?? ""))
      const failed = error !== undefined || raw.startsWith("ERROR:")
      const t = cut(raw, RESULT_CAP)
      this.emit({
        kind: "tool.result",
        summary: `${tool} ${failed ? "failed" : "returned"}${t.text ? `: ${t.text.split("\n")[0]}` : ""}`,
        payload: { tool, callId, output: t.text, ...(failed ? { error: t.text.slice(0, 500) || "failed" } : {}), ...(t.truncated ? { truncated: true } : {}) },
      })
      this.arm()
    }
    return [
      {
        handleLLMStart: () => this.arm(),
        handleChatModelStart: () => this.arm(),
        handleLLMEnd: (output: { generations?: { text?: string; message?: BaseMessage }[][] }) => {
          const g = output.generations?.[0]?.[0]
          const text = clean(g?.message ? textOf(g.message) : (g?.text ?? "")).trim()
          if (text) {
            const t = cut(text, TEXT_CAP)
            this.emit({ kind: "text", summary: t.text.split("\n")[0], payload: { output: t.text, ...(t.truncated ? { truncated: true } : {}) } })
          }
          this.arm()
        },
        handleToolStart: (_t: unknown, input: string, runId: string, _p?: string, _tags?: string[], _m?: unknown, runName?: string, toolCallId?: string) => {
          const tool = clean(runName ?? "tool")
          const callId = clean(toolCallId ?? runId)
          calls.set(runId, { tool, callId })
          this.open.add(runId)
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(String(input ?? "{}")) as Record<string, unknown>
          } catch {
            args = {}
          }
          const a = cut(clean(input), ARGS_CAP)
          const files = agentFilesOf(tool, args)
          const target = files[0]?.path ?? ""
          this.emit({
            kind: "tool.call",
            summary: `${tool}${target ? ` ${target}` : ""}`,
            payload: { tool, callId, input: a.text, files, ...(a.truncated ? { truncated: true } : {}) },
          })
          this.arm()
        },
        handleToolEnd: (output: unknown, runId: string) => end(runId, output),
        handleToolError: (err: unknown, runId: string) => end(runId, undefined, err),
      },
    ]
  }

  /** One user turn; resolves with that turn's answer (R2.1). */
  async send(text: string): Promise<StreamResult> {
    if (this.failure) throw this.failure
    if (this.turn) throw new SpecialistError("failed", "A turn is already in progress.")
    if (!this.started) {
      this.started = true
      this.emit({
        kind: "init",
        summary: `Specialist on ${this.o.provider} · ${this.o.modelName}`,
        payload: { model: this.o.modelName, ...(this.o.notice ? { error: this.o.notice } : {}) },
      })
    }
    const at = Date.now()
    this.usage = {
      tokensIn: 0,
      tokensOut: 0,
      cacheTokens: 0,
      costUsd: 0,
      costStatus: "unknown",
      estimate: false,
      model: this.o.modelName,
      rateSnapshot: undefined,
      cacheHypothesis: undefined,
    }
    this.turn = new AbortController()
    this.arm()
    try {
      const out = (await this.agent.invoke({ messages: [new HumanMessage(text)] } as never, {
        configurable: { thread_id: this.thread },
        signal: this.turn.signal,
        callbacks: this.callbacks() as never,
        recursionLimit: RECURSION_LIMIT,
      })) as { messages?: BaseMessage[] }
      if (this.failure) throw this.failure
      const answer = clean(textOf([...(out.messages ?? [])].reverse().find((m) => AIMessage.isInstance(m)))).trim()
      const r: StreamResult = {
        text: answer,
        error: false,
        session: this.thread,
        durationMs: Date.now() - at,
        costUsd: this.usage.costUsd,
        tokensIn: this.usage.tokensIn,
        tokensOut: this.usage.tokensOut,
        cacheTokens: this.usage.cacheTokens,
        model: this.usage.model || this.o.modelName,
      }
      const t = cut(answer, TEXT_CAP)
      this.emit({
        kind: "result",
        summary: `Specialist answered in ${(r.durationMs / 1000).toFixed(1)} s`,
        payload: {
          output: t.text,
          model: r.model,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          cacheTokens: this.usage.cacheTokens,
          costUsd: this.usage.costUsd,
          costStatus: this.usage.costStatus,
          estimate: this.usage.estimate,
          rateSnapshot: this.usage.rateSnapshot,
          cacheHypothesis: this.usage.cacheHypothesis,
          promptTokensIncludesCache: true,
        },
      })
      return r
    } catch (e) {
      const failure = this.failure ?? (e instanceof SpecialistError ? e : classifyAgentFailure(e, this.o.provider))
      // A failed turn still spent what it spent.
      this.emit({
        kind: "result",
        summary: `Specialist failed: ${failure.message.split("\n")[0]}`,
        payload: {
          error: failure.message,
          model: this.usage.model || this.o.modelName,
          tokensIn: this.usage.tokensIn,
          tokensOut: this.usage.tokensOut,
          cacheTokens: this.usage.cacheTokens,
          costUsd: this.usage.costUsd,
          costStatus: this.usage.costStatus,
          estimate: this.usage.estimate,
          rateSnapshot: this.usage.rateSnapshot,
          cacheHypothesis: this.usage.cacheHypothesis,
          promptTokensIncludesCache: true,
        },
      })
      throw failure
    } finally {
      this.disarm()
      this.turn = null
      this.open.clear()
    }
  }

  /** Stops what the run holds; safe to call more than once. */
  async close(): Promise<void> {
    this.o.signal?.removeEventListener("abort", this.abort)
    this.disposed ??= (this.o.dispose?.() ?? Promise.resolve()).catch(() => undefined)
    await this.disposed
  }

  /** Stops the turn in flight and what the run holds, reporting it as cancelled or timed out. */
  async kill(kind: "cancelled" | "timeout"): Promise<void> {
    if (this.failure) return
    this.failure = new SpecialistError(
      kind,
      kind === "timeout"
        ? this.open.size
          ? "A tool call of the specialist stayed open too long and the delegation was stopped."
          : `The specialist was inactive for ${Math.round(this.o.idleMs / 60_000) || Math.round(this.o.idleMs / 1000)} ${this.o.idleMs >= 60_000 ? "min" : "s"} and was stopped.`
        : "Cancelled.",
    )
    this.disarm()
    this.turn?.abort()
    await this.close()
  }
}
