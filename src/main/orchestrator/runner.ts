import { statSync } from "node:fs"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Command, MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph"
import type { PatchView, TaskRow, TaskState } from "@shared/types"
import { rejectPatch, type DelegationDeps } from "../delegation"
import { buildAgent, type AgentBackend } from "./agent"
import { friendlyError } from "./errors"
import { makeModel } from "./model"
import { APPLY_PATCH } from "./tools"

/*
  A task's lifecycle (specs/orchestrator R3): start a run, pause it when the agent asks to apply a
  patch, resume it with the user's decision from the checkpointer, record the consolidated answer,
  cancel it, or retry it from its original request. Todo list changes become steps.
*/

/** Where the orchestrator's tools run for one task, and how to take it down. */
export interface TaskWorkspace {
  backend: AgentBackend
  /** the source folder's path as the agent sees it */
  root: string
  dispose(): Promise<void>
}

export interface RunnerDeps extends DelegationDeps {
  apiKey(): string | null
  /** the task's sandbox for the orchestrator's tools (adr:0007-run-the-orchestrators-tools-in-a-task-container) */
  workspace(task: TaskRow): Promise<TaskWorkspace>
  checkpointer?: BaseCheckpointSaver
}

interface Live {
  abort: AbortController
  /** the agent, once the task's workspace is up */
  ready: Promise<{ agent: ReturnType<typeof buildAgent>; ws: TaskWorkspace }>
  /** patch ids the paused run waits on, in the order of its action requests, with each decision once made */
  pending: { patchId: string; decision: "approve" | "reject" | null }[]
  run: Promise<void>
  callbacks: unknown[]
  /** todo text → its step */
  todoSteps: Map<string, string>
}

type Todo = { content?: string; status?: string }
type Interrupt = { value?: { actionRequests?: { name: string; args: { patchId?: string } }[] } }

const TODO_STATE: Record<string, TaskState> = { pending: "pending", in_progress: "running", completed: "done" }

function text(m: BaseMessage): string {
  const c = m.content
  if (typeof c === "string") return c
  return (c as { type?: string; text?: string }[]).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("")
}

export class TaskRunner {
  private readonly deps: RunnerDeps
  private readonly checkpointer: BaseCheckpointSaver
  private readonly live = new Map<string, Live>()

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.checkpointer = deps.checkpointer ?? new MemorySaver()
  }

  start(input: { request: string; sourceRoot: string }): TaskRow {
    let dir = false
    try {
      dir = statSync(input.sourceRoot).isDirectory()
    } catch {
      dir = false
    }
    if (!dir) throw new Error(`${input.sourceRoot} is not a folder.`)
    const apiKey = this.deps.apiKey()
    if (!apiKey) throw new Error("Set your OpenRouter API key in Settings first.")
    const { log } = this.deps
    const task = log.createTask({ request: input.request, sourceRoot: input.sourceRoot, model: this.deps.settings().model })
    const abort = new AbortController()
    const model = makeModel({
      apiKey,
      model: task.model,
      onUsage: (u) => {
        log.append({
          taskId: task.id,
          agent: "orchestrator",
          kind: "model.call",
          summary: `${u.model}: ${u.tokensIn} in, ${u.tokensOut} out`,
          payload: { ...u },
        })
        log.addUsage(task.id, { tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd })
      },
    })
    const ready = this.deps.workspace(task).then((ws) => ({
      ws,
      agent: buildAgent({
        model,
        ctx: { deps: this.deps, taskId: task.id, sourceRoot: task.sourceRoot, root: ws.root, signal: abort.signal },
        checkpointer: this.checkpointer,
        backend: ws.backend,
      }),
    }))
    ready.catch(() => undefined)
    const names = new Map<string, string>()
    const callbacks = [
      {
        handleToolStart: (_tool: unknown, toolInput: string, runId: string, _parent?: string, _tags?: string[], _meta?: unknown, runName?: string) => {
          const name = runName ?? "tool"
          names.set(runId, name)
          if (name === "write_todos") return
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.call",
            summary: name,
            payload: { tool: name, input: String(toolInput ?? "").slice(0, 4000) },
          })
        },
        handleToolEnd: (output: unknown, runId: string) => {
          const name = names.get(runId) ?? "tool"
          names.delete(runId)
          if (name === "write_todos") return
          const out = typeof output === "string" ? output : String((output as { content?: unknown })?.content ?? "")
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.result",
            summary: `${name} ${out.startsWith("ERROR:") ? "failed" : "returned"}`,
            payload: { tool: name, output: out.slice(0, 8000) },
          })
        },
        handleToolError: (err: unknown, runId: string) => {
          const name = names.get(runId) ?? "tool"
          names.delete(runId)
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.error",
            summary: `${name} failed`,
            payload: { tool: name, error: String((err as Error)?.message ?? err).slice(0, 2000) },
          })
        },
      },
    ]
    const live: Live = { abort, ready, pending: [], run: Promise.resolve(), callbacks, todoSteps: new Map() }
    this.live.set(task.id, live)
    log.updateTask(task.id, { state: "running" })
    log.append({
      taskId: task.id,
      agent: "orchestrator",
      kind: "task.started",
      state: "running",
      summary: "Task started",
      payload: { input: task.request, model: task.model },
    })
    live.run = this.drive(task.id, { messages: [new HumanMessage(task.request)] }, callbacks)
    return log.getTask(task.id)
  }

  /** The todo list as steps: one per todo, created once and updated as its status moves (R2.1). */
  private todos(taskId: string, todos: Todo[], steps: Map<string, string>) {
    for (const t of todos) {
      const title = String(t.content ?? "").trim()
      if (!title) continue
      const state = TODO_STATE[String(t.status)] ?? "pending"
      const id = steps.get(title)
      if (id) this.deps.log.updateStep(id, { state })
      else steps.set(title, this.deps.log.addStep({ taskId, kind: "todo", title, agent: "orchestrator", state }).id)
    }
    this.deps.log.append({ taskId, agent: "orchestrator", kind: "todos", summary: `Plan: ${todos.length} step(s)`, payload: { output: todos } })
  }

  private async drive(taskId: string, input: unknown, callbacks: unknown[]): Promise<void> {
    const live = this.live.get(taskId)
    if (!live) return
    const { log } = this.deps
    try {
      const { agent } = await live.ready
      const config = { configurable: { thread_id: taskId } }
      const stream = await agent.stream(input as never, {
        ...config,
        signal: live.abort.signal,
        callbacks: callbacks as never,
        recursionLimit: 200,
        streamMode: "updates",
      })
      const interrupts: Interrupt[] = []
      // Node by node, so the todo list reaches the UI as the agent writes it.
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        for (const [node, update] of Object.entries(chunk ?? {})) {
          if (node === "__interrupt__") interrupts.push(...(update as Interrupt[]))
          else
            for (const u of Array.isArray(update) ? update : [update])
              if (Array.isArray((u as { todos?: unknown })?.todos)) this.todos(taskId, (u as { todos: Todo[] }).todos, live.todoSteps)
        }
      }
      const requests = interrupts.flatMap((i) => i.value?.actionRequests ?? [])
      if (requests.length) {
        live.pending = requests.map((r) => ({ patchId: String(r.args?.patchId ?? ""), decision: null }))
        for (const p of live.pending) {
          let known: PatchView | null = null
          try {
            known = log.getPatch(p.patchId)
          } catch {
            known = null
          }
          // An approval request for a patch this task never proposed cannot be shown to the user.
          if (!known || known.taskId !== taskId || known.state !== "proposed") p.decision = "reject"
        }
        if (live.pending.every((p) => p.decision)) return this.resume(taskId)
        log.updateTask(taskId, { state: "waiting" })
        log.append({
          taskId,
          agent: "orchestrator",
          kind: "approval.requested",
          state: "waiting",
          summary: `Waiting for approval of ${live.pending.filter((p) => !p.decision).length} patch(es)`,
          payload: { tool: APPLY_PATCH, input: live.pending.map((p) => p.patchId) },
        })
        return
      }
      const messages =
        ((await (agent as unknown as { getState(c: unknown): Promise<{ values: unknown }> }).getState(config)).values as { messages?: BaseMessage[] })
          .messages ?? []
      const last = [...messages].reverse().find((m) => AIMessage.isInstance(m) && !(m as AIMessage).tool_calls?.length)
      const answer = last ? text(last).trim() : ""
      log.updateTask(taskId, { state: "done", result: answer })
      log.append({ taskId, agent: "orchestrator", kind: "task.done", state: "done", summary: "Task finished", payload: { output: answer } })
      this.end(taskId)
    } catch (e) {
      const cancelled = live.abort.signal.aborted
      const err = cancelled ? new Error("Cancelled.") : friendlyError(e)
      log.updateTask(taskId, { state: cancelled ? "cancelled" : "failed", error: err.message })
      log.append({
        taskId,
        agent: "orchestrator",
        kind: cancelled ? "task.cancelled" : "task.failed",
        state: cancelled ? "cancelled" : "failed",
        summary: err.message,
        payload: { error: err.message },
      })
      this.settleSteps(taskId, cancelled ? "cancelled" : "failed")
      this.end(taskId)
    }
  }

  private resume(taskId: string): Promise<void> {
    const live = this.live.get(taskId)!
    const decisions = live.pending.map((p) => ({ type: p.decision! }))
    for (const p of live.pending) if (p.decision === "reject") this.rejectQuietly(p.patchId, taskId)
    live.pending = []
    this.deps.log.updateTask(taskId, { state: "running" })
    this.deps.log.append({
      taskId,
      agent: "orchestrator",
      kind: "approval.resumed",
      state: "running",
      summary: `Resumed with ${decisions.map((d) => d.type).join(", ")}`,
      payload: { output: decisions },
    })
    live.run = this.drive(taskId, new Command({ resume: { decisions } }), live.callbacks)
    return live.run
  }

  private rejectQuietly(patchId: string, taskId: string) {
    try {
      const p = this.deps.log.getPatch(patchId)
      if (p.taskId === taskId && p.state === "proposed") rejectPatch(this.deps, patchId)
    } catch {
      // an unknown patch id has nothing to reject
    }
  }

  /** The user's decision on a patch the paused run waits on (R3.1, R3.2). */
  decide(taskId: string, patchId: string, decision: "approve" | "reject"): PatchView {
    const live = this.live.get(taskId)
    const slot = live?.pending.find((p) => p.patchId === patchId && !p.decision)
    if (!live || !slot) throw new Error("That patch is not waiting for a decision.")
    slot.decision = decision
    this.deps.log.append({
      taskId,
      agent: "app",
      kind: "approval.decided",
      summary: `The user chose to ${decision} the patch`,
      payload: { patchId, output: decision },
    })
    if (live.pending.every((p) => p.decision)) void this.resume(taskId)
    return this.deps.log.getPatch(patchId)
  }

  /** Abort the model call and every running delegation (R3.4). */
  cancel(taskId: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live || !["running", "waiting", "pending"].includes(task.state)) throw new Error(`The task is ${task.state}, not running.`)
    live.abort.abort()
    if (task.state === "waiting") {
      for (const p of live.pending) this.rejectQuietly(p.patchId, taskId)
      this.deps.log.updateTask(taskId, { state: "cancelled", error: "Cancelled." })
      this.deps.log.append({ taskId, agent: "orchestrator", kind: "task.cancelled", state: "cancelled", summary: "Cancelled.", payload: {} })
      this.settleSteps(taskId, "cancelled")
      this.end(taskId)
    }
    return this.deps.log.getTask(taskId)
  }

  /** Whether the task has a run in this process, running or paused for approval. */
  isLive(taskId: string): boolean {
    return this.live.has(taskId)
  }

  private settleSteps(taskId: string, state: "cancelled" | "failed") {
    for (const s of this.deps.log.steps(taskId)) if (s.state === "running" || s.state === "pending") this.deps.log.updateStep(s.id, { state })
  }

  /** A new run from the same request and source folder (R3.5). */
  retry(taskId: string): TaskRow {
    const t = this.deps.log.getTask(taskId)
    if (!["interrupted", "failed", "cancelled"].includes(t.state))
      throw new Error(`Only an interrupted, failed or cancelled task can be retried; this one is ${t.state}.`)
    return this.start({ request: t.request, sourceRoot: t.sourceRoot })
  }

  /** Settles when the task's current run stops, at its end or at an approval pause. */
  async settled(taskId: string): Promise<void> {
    for (;;) {
      const live = this.live.get(taskId)
      if (!live) return
      const run = live.run
      await run
      if (this.live.get(taskId)?.run === run) return
    }
  }

  /** Forget a task's run and take its workspace down. */
  private end(taskId: string) {
    const live = this.live.get(taskId)
    this.live.delete(taskId)
    live?.ready.then(({ ws }) => ws.dispose()).catch(() => undefined)
  }

  /** Abort every run and take every workspace down, e.g. when the app quits. */
  stopAll() {
    for (const [id, l] of [...this.live]) {
      l.abort.abort()
      this.end(id)
    }
  }
}
