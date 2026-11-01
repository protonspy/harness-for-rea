import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph"
import {
  ALWAYS_GATED,
  checkAnswer,
  GATEABLE_TOOLS,
  QUESTION_CAP,
  type Answer,
  type GateableTool,
  type Origin,
  type Question,
  type ToolDecision,
} from "@shared/chat"
import { PROVIDERS, type ProviderId } from "@shared/providers"
import type { PatchView, ProjectRow, TaskRow, TaskState } from "@shared/types"
import { rejectPatch, type DelegationDeps } from "../delegation"
import { baseUrlFor } from "../readiness"
import { buildAgent, type AgentBackend } from "./agent"
import { friendlyError } from "./errors"
import { makeModel } from "./model"
import type { TaskSandboxes } from "../sandbox/specialistbox"
import { RESTARTED } from "../sandbox/taskbox"
import { SqliteSaver } from "./checkpoint"
import { APPLY_PATCH, type ToolContext } from "./tools"

/*
  A task's lifecycle (specs/orchestrator R3, specs/chat R1): start a conversation, pause a turn when
  the agent asks to apply a patch, resume it with the user's decision from the checkpointer, leave a
  finished turn awaiting the user, start the next turn on the same thread from their next message,
  close it, cancel it, or retry it from its original request. Todo list changes become steps.
*/

/** Where the orchestrator's tools run for one task, and how to take it down. */
export interface TaskWorkspace {
  backend: AgentBackend
  /** the source folder's path as the agent sees it */
  root: string
  /** the writable place for the agent's own code, when the backend has one (adr:0009-give-the-orchestrator-a-writable-scratch) */
  scratch?: string
  /** the sandboxes the orchestrator creates for the specialist, stopped with the workspace (specs/specialist-sandbox R2.6) */
  sandboxes?: TaskSandboxes
  /** the task's container had to be created again: what was installed in it is gone (specs/task-persistence R3.5) */
  created?: boolean
  /** stop the containers and keep them for when the task reopens (specs/task-persistence R3.4) */
  dispose(): Promise<void>
}

export interface RunnerDeps extends DelegationDeps {
  apiKey(provider: ProviderId): string | null
  /** the task's sandbox for the orchestrator's tools (adr:0007-run-the-orchestrators-tools-in-a-task-container) */
  workspace(task: TaskRow): Promise<TaskWorkspace>
  /** the projects tasks belong to: their target, goal, model and efforts (specs/projects R2.1) */
  projects?: { get(id: string): ProjectRow }
  /** remove the containers of a task being deleted (specs/task-persistence R4.1) */
  removeContainers?(task: TaskRow): Promise<void>
  checkpointer?: BaseCheckpointSaver
  /** how long a continued turn waits for the stopped one's stream to wind down (specs/chat R3.3) */
  stopGraceMs?: number
}

const STOP_GRACE_MS = 5000
/** The states a task with no run in this process can be continued from (specs/task-persistence R2.1). */
const REOPENABLE: TaskState[] = ["cancelled", "failed", "interrupted", "done", "awaiting-user", "stopped"]
/** What the orchestrator reads when the user continues a task with nothing pending on its thread. */
const CONTINUE = "Continue the task from where it stopped. Your files in /scratch and your sandboxes are as you left them."
const STOPPED = "The user stopped the turn before deciding."
const TIMED_OUT = "No decision came within the approval timeout, so the call was rejected."

interface Live {
  /** the current turn's: a stop aborts it, the next turn gets a fresh one */
  abort: AbortController
  /** what the agent's tools read, its signal following the current turn */
  ctx: ToolContext
  /** bumped at every stop and new turn, so a stream the stop missed is ignored when it ends (specs/chat R3.3) */
  turnNo: number
  /** the agent, once the task's workspace is up */
  ready: Promise<{ agent: ReturnType<typeof buildAgent>; ws: TaskWorkspace }>
  /** the gated calls the paused turn waits on, in the order of its action requests (specs/chat R4.2) */
  pending: PendingCall[]
  /** rejects what is still pending once the approval timeout passes (specs/chat R4.5) */
  approvalTimer?: ReturnType<typeof setTimeout>
  run: Promise<void>
  callbacks: unknown[]
  /** todo text → its step */
  todoSteps: Map<string, string>
  /** drives under way; one hands over to the next, so more than one can overlap */
  streaming: number
  /** ids of the agent messages already recorded */
  said: Set<string>
  /** messages the user sent while a turn ran, for the orchestrator's next model call (specs/chat R2.1) */
  inbox: string[]
  /** questions either agent waits on, by id (specs/chat R5) */
  questions: Map<string, { question: Question; settle(answer: Answer, origin: Origin): void }>
  /** questions asked this turn, against the cap (R5.5) */
  asked: number
}

interface PendingCall {
  callId: string
  name: string
  args: Record<string, unknown>
  decision: ToolDecision | null
  origin?: Origin
}

type Todo = { content?: string; status?: string }
type Interrupt = { value?: { actionRequests?: { name: string; args: Record<string, unknown> }[] } }

const patchOf = (p: PendingCall) => (p.name === APPLY_PATCH ? String(p.args.patchId ?? "") : null)

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
  private readonly disposals = new Set<Promise<void>>()
  /** tasks being deleted, which nothing may reopen */
  private readonly deleting = new Set<string>()
  /** each task's workspace still going down, which a reopen of that task waits for */
  private readonly disposing = new Map<string, Promise<void>>()

  constructor(deps: RunnerDeps) {
    this.deps = deps
    // The conversation outlives the process (specs/task-persistence R1).
    this.checkpointer = deps.checkpointer ?? new SqliteSaver()
  }

  start(input: { request: string; sourceRoot?: string; projectId?: string | null; gated?: GateableTool[]; auto?: boolean }): TaskRow {
    // A task in a project runs on its target with its model (specs/projects R2.1); one without names a folder.
    const project = input.projectId && this.deps.projects ? this.deps.projects.get(input.projectId) : null
    const sourceRoot = project?.sourceRoot ?? input.sourceRoot ?? ""
    let dir = false
    try {
      dir = statSync(sourceRoot).isDirectory()
    } catch {
      dir = false
    }
    if (!dir) throw new Error(`${sourceRoot || "The source"} is not a folder.`)
    const run = this.runWith(project)
    const apiKey = this.deps.apiKey(run.provider)
    if (!apiKey) throw new Error(`Set your ${PROVIDERS[run.provider].label} API key in Settings first.`)
    const { log } = this.deps
    const task = log.createTask({ request: input.request, sourceRoot, model: run.model, projectId: project?.id ?? null })
    const auto = input.auto === true
    const gated = auto ? [] : [...new Set<GateableTool>([ALWAYS_GATED, ...(input.gated ?? [])])]
    const live = this.open(task, auto, gated, apiKey)
    log.updateTask(task.id, { state: "running" })
    log.append({
      taskId: task.id,
      agent: "orchestrator",
      kind: "task.started",
      state: "running",
      summary: "Task started",
      payload: { input: task.request, model: task.model, gated, auto },
    })
    this.userMessage(task.id, task.request)
    live.run = this.drive(task.id, { messages: [new HumanMessage(task.request)] }, live.callbacks)
    return log.getTask(task.id)
  }

  /**
    The live run of a task that exists: its model, tool context, workspace and agent on the task's thread. A new
    task opens once; a cancelled, failed, interrupted or closed one opens again on the same thread
    (specs/task-persistence R2).
  */
  /** The provider, model and efforts a task runs with: its project's, or the Settings defaults (specs/projects R2.1). */
  private runWith(project: ProjectRow | null) {
    const s = this.deps.settings()
    return project
      ? { provider: project.provider, model: project.model, orchestratorEffort: project.orchestratorEffort, specialistEffort: project.specialistEffort }
      : { provider: s.provider, model: s.model, orchestratorEffort: s.orchestratorEffort, specialistEffort: s.specialistEffort }
  }

  private open(task: TaskRow, auto: boolean, gated: GateableTool[], key?: string): Live {
    const { log } = this.deps
    const settings = this.deps.settings()
    const project = task.projectId && this.deps.projects ? this.deps.projects.get(task.projectId) : null
    const run = this.runWith(project)
    const apiKey = key ?? this.deps.apiKey(run.provider)
    if (!apiKey) throw new Error(`Set your ${PROVIDERS[run.provider].label} API key in Settings first.`)
    const abort = new AbortController()
    // The base URL is the provider's, kept in Settings: a project names the provider, not its endpoint.
    const baseUrl = baseUrlFor(run.provider, settings)
    if (!baseUrl) throw new Error(`Set the base URL of your ${PROVIDERS[run.provider].label} in Settings, with Settings on that provider.`)
    const model = makeModel({
      provider: run.provider,
      baseUrl,
      apiKey,
      model: task.model,
      effort: run.orchestratorEffort,
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
    const ctx: ToolContext = {
      deps: this.deps,
      taskId: task.id,
      sourceRoot: task.sourceRoot,
      root: "",
      signal: abort.signal,
      ask: (q, agent, stepId) => this.ask(task.id, q, agent, stepId),
      projectId: task.projectId,
      specialistEffort: run.specialistEffort,
    }
    ctx.auto = auto
    // A task closed a moment ago is still stopping its containers: bring them up only once they stopped.
    const ready = (this.disposing.get(task.id) ?? Promise.resolve())
      .then(() => this.deps.workspace(task))
      .then((ws) => ({
        ws,
        agent: buildAgent({
          model,
          ctx: Object.assign(ctx, {
            root: ws.root,
            scratch: ws.scratch,
            sandboxes: ws.sandboxes,
            readScratch: async (paths: string[]) => (await ws.backend.downloadFiles(paths)).map((f) => ({ path: f.path, content: f.content ?? null })),
          }),
          checkpointer: this.checkpointer,
          backend: ws.backend,
          inbox: () => this.drainInbox(task.id),
          gated,
          auto,
          scratch: ws.scratch,
          goal: project?.goal,
          // What earlier tasks of the project established, counted when this one opens (specs/projects R2.5).
          analyses: task.projectId ? log.projectAnalyses(task.projectId).filter((a) => a.taskId !== task.id).length : 0,
        }),
      }))
    ready.catch(() => undefined)
    const names = new Map<string, { name: string; callId: string }>()
    const callbacks = [
      {
        handleToolStart: (
          _tool: unknown,
          toolInput: string,
          runId: string,
          _parent?: string,
          _tags?: string[],
          _meta?: unknown,
          runName?: string,
          toolCallId?: string,
        ) => {
          const name = runName ?? "tool"
          // The call's id pairs its result, and the delegation it starts, on a page that begins mid-task (specs/chat-timeline R1.1).
          const callId = toolCallId ?? ""
          names.set(runId, { name, callId })
          if (name === "write_todos") return
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.call",
            summary: name,
            payload: { tool: name, input: String(toolInput ?? "").slice(0, 4000), ...(callId ? { callId } : {}) },
          })
        },
        handleToolEnd: (output: unknown, runId: string) => {
          const { name, callId } = names.get(runId) ?? { name: "tool", callId: "" }
          names.delete(runId)
          if (name === "write_todos") return
          const out = typeof output === "string" ? output : String((output as { content?: unknown })?.content ?? "")
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.result",
            summary: `${name} ${out.startsWith("ERROR:") ? "failed" : "returned"}`,
            payload: { tool: name, output: out.slice(0, 8000), ...(callId ? { callId } : {}) },
          })
        },
        handleToolError: (err: unknown, runId: string) => {
          const { name, callId } = names.get(runId) ?? { name: "tool", callId: "" }
          names.delete(runId)
          log.append({
            taskId: task.id,
            agent: "orchestrator",
            kind: "tool.error",
            summary: `${name} failed`,
            payload: { tool: name, error: String((err as Error)?.message ?? err).slice(0, 2000), ...(callId ? { callId } : {}) },
          })
        },
      },
    ]
    const live: Live = {
      abort,
      ctx,
      turnNo: 0,
      ready,
      pending: [],
      run: Promise.resolve(),
      callbacks,
      todoSteps: new Map(),
      streaming: 0,
      said: new Set(),
      inbox: [],
      questions: new Map(),
      asked: 0,
    }
    this.live.set(task.id, live)
    return live
  }

  /** The tool-call choice a task started with: every call without asking unless it was started with gates (specs/chat R4.1). */
  private startedWith(taskId: string): { auto: boolean; gated: GateableTool[] } {
    const started = this.deps.log.history(taskId).events.find((e) => e.kind === "task.started")
    const auto = started?.payload.auto !== false
    const gated = (started?.payload.gated as unknown[] | undefined)?.filter((g): g is GateableTool => (GATEABLE_TOOLS as readonly unknown[]).includes(g))
    return { auto, gated: auto ? [] : [...new Set<GateableTool>([ALWAYS_GATED, ...(gated ?? [])])] }
  }

  /**
    Open a task that has no run in this process again, on its thread (specs/task-persistence R1.2, R2): its
    containers come up, and a container that had to be created again is reported to the orchestrator.
  */
  private reopen(taskId: string): Live {
    if (this.deleting.has(taskId)) throw new Error("The task is being deleted.")
    const task = this.deps.log.getTask(taskId)
    const { auto, gated } = this.startedWith(taskId)
    const live = this.open(task, auto, gated)
    live.ready.then(({ ws }) => ws.created && live.inbox.push(RESTARTED)).catch(() => undefined)
    this.deps.log.append({ taskId, agent: "app", kind: "task.reopened", summary: "Task reopened where it stopped", payload: {} })
    return live
  }

  /**
    Continue a task from where it stopped (specs/task-persistence R2.1): a stopped turn of a live run, or a
    cancelled, failed, interrupted or closed task opened again from its last checkpoint.
  */
  continueTask(taskId: string): TaskRow {
    const task = this.deps.log.getTask(taskId)
    const live = this.live.get(taskId)
    if (live && task.state === "stopped") return this.continueTurn(taskId)
    if (live) throw new Error(`The task is ${task.state}; it is still open.`)
    if (!REOPENABLE.includes(task.state))
      throw new Error(`The task is ${task.state}; only a stopped, cancelled, failed, interrupted or closed task can be continued.`)
    const opened = this.reopen(taskId)
    this.deps.log.updateTask(taskId, { state: "running", error: "" })
    this.deps.log.append({ taskId, agent: "app", kind: "turn.continued", state: "running", summary: "You continued the task", payload: {} })
    opened.run = this.fromCheckpoint(taskId, opened)
    return this.deps.log.getTask(taskId)
  }

  /**
    Drive a reopened task on from its last checkpoint (specs/task-persistence R2): a step left pending — an approval
    the task waited on — runs again and asks again, the user's message waiting in the inbox for the next model call;
    otherwise the turn opens on the message, or on a nudge to continue. A reopen that cannot start fails the task.
  */
  private async fromCheckpoint(taskId: string, live: Live, message?: string): Promise<void> {
    let input: unknown
    try {
      const { agent } = await live.ready
      const snap = await (agent as unknown as { getState(c: unknown): Promise<{ next?: string[] }> }).getState({ configurable: { thread_id: taskId } })
      if (snap.next?.length) {
        if (message) live.inbox.push(message)
        input = null
      } else {
        if (message) this.deps.log.append({ taskId, agent: "orchestrator", kind: "message.read", summary: "Read your message", payload: { output: message } })
        input = { messages: [new HumanMessage(message ?? CONTINUE)] }
      }
    } catch (e) {
      const err = friendlyError(e, PROVIDERS[this.deps.settings().provider].label)
      this.deps.log.updateTask(taskId, { state: "failed", error: err.message })
      this.deps.log.append({ taskId, agent: "orchestrator", kind: "task.failed", state: "failed", summary: err.message, payload: { error: err.message } })
      void this.end(taskId)
      return
    }
    return this.drive(taskId, input, live.callbacks)
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

  /** A message from the user, in the task's log with its other events (specs/chat R1.3). */
  private userMessage(taskId: string, message: string) {
    this.deps.log.append({ taskId, agent: "app", kind: "message.user", summary: message.slice(0, 200), payload: { output: message } })
  }

  /** The queued messages, each recorded as read by the agent as it takes them (R2.2). */
  private drainInbox(taskId: string): string[] {
    const live = this.live.get(taskId)
    if (!live?.inbox.length) return []
    const taken = live.inbox.splice(0)
    for (const m of taken) this.deps.log.append({ taskId, agent: "orchestrator", kind: "message.read", summary: "Read your message", payload: { output: m } })
    return taken
  }

  /** Every agent message with text, once, as the stream delivers it (specs/chat R1.3). */
  private agentMessages(taskId: string, update: unknown, said: Set<string>) {
    const messages = (update as { messages?: unknown })?.messages
    if (!Array.isArray(messages)) return
    for (const m of messages as BaseMessage[]) {
      if (!AIMessage.isInstance(m)) continue
      const body = text(m).trim()
      const key = m.id ?? body
      if (!body || said.has(key)) continue
      said.add(key)
      this.deps.log.append({ taskId, agent: "orchestrator", kind: "message.agent", summary: body.slice(0, 200), payload: { output: body } })
    }
  }

  private async drive(taskId: string, input: unknown, callbacks: unknown[]): Promise<void> {
    const live = this.live.get(taskId)
    if (!live) return
    const { log } = this.deps
    const turnNo = live.turnNo
    // A turn the user stopped no longer speaks for the conversation.
    const stale = () => live.turnNo !== turnNo
    live.streaming++
    try {
      const { agent } = await live.ready
      const config = { configurable: { thread_id: taskId } }
      const stream = await agent.stream(input as never, {
        ...config,
        signal: live.abort.signal,
        callbacks: callbacks as never,
        streamMode: "updates",
      })
      const interrupts: Interrupt[] = []
      // Node by node, so the todo list reaches the UI as the agent writes it.
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        if (stale()) return
        for (const [node, update] of Object.entries(chunk ?? {})) {
          if (node === "__interrupt__") interrupts.push(...(update as Interrupt[]))
          else
            for (const u of Array.isArray(update) ? update : [update]) {
              if (Array.isArray((u as { todos?: unknown })?.todos)) this.todos(taskId, (u as { todos: Todo[] }).todos, live.todoSteps)
              this.agentMessages(taskId, u, live.said)
            }
        }
      }
      if (stale()) return
      const requests = interrupts.flatMap((i) => i.value?.actionRequests ?? [])
      if (requests.length) {
        live.pending = requests.map((r) => ({ callId: randomUUID(), name: r.name, args: r.args ?? {}, decision: null }))
        for (const p of live.pending) {
          const patchId = patchOf(p)
          if (patchId === null) continue
          let known: PatchView | null = null
          try {
            known = log.getPatch(patchId)
          } catch {
            known = null
          }
          // An approval request for a patch this task never proposed cannot be shown to the user.
          if (!known || known.taskId !== taskId || known.state !== "proposed")
            p.decision = { type: "reject", message: `There is no proposed patch ${patchId} in this task.` }
        }
        if (live.pending.every((p) => p.decision)) return this.resume(taskId)
        const open = live.pending.filter((p) => !p.decision)
        log.updateTask(taskId, { state: "waiting" })
        log.append({
          taskId,
          agent: "orchestrator",
          kind: "approval.requested",
          state: "waiting",
          summary: `Waiting for your decision on ${open.map((p) => p.name).join(", ")}`,
          payload: { calls: open.map(({ callId, name, args }) => ({ callId, name, args })) },
        })
        live.approvalTimer = setTimeout(() => {
          for (const p of live.pending.filter((x) => !x.decision)) this.decideTool(taskId, p.callId, { type: "reject", message: TIMED_OUT }, "timeout")
        }, this.deps.settings().approvalTimeoutMinutes * 60_000)
        live.approvalTimer.unref?.()
        return
      }
      // A message sent during the last model call has had no reader yet: it opens the next turn now.
      if (live.inbox.length) {
        live.run = this.drive(taskId, { messages: this.drainInbox(taskId).map((m) => new HumanMessage(m)) }, callbacks)
        return
      }
      const messages =
        ((await (agent as unknown as { getState(c: unknown): Promise<{ values: unknown }> }).getState(config)).values as { messages?: BaseMessage[] })
          .messages ?? []
      // A stop during that read owns the task's state now (R3.3).
      if (stale()) return
      const last = [...messages].reverse().find((m) => AIMessage.isInstance(m) && !(m as AIMessage).tool_calls?.length)
      const answer = last ? text(last).trim() : ""
      // The turn is over, the conversation is not: the agent, thread and container stay (R1.4).
      log.updateTask(taskId, { state: "awaiting-user", result: answer })
      log.append({ taskId, agent: "orchestrator", kind: "turn.done", state: "awaiting-user", summary: "Your turn", payload: { output: answer } })
    } catch (e) {
      if (stale()) return
      const cancelled = live.abort.signal.aborted
      const err = cancelled ? new Error("Cancelled.") : friendlyError(e, PROVIDERS[this.deps.settings().provider].label)
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
    } finally {
      live.streaming--
    }
  }

  private resume(taskId: string): Promise<void> {
    const live = this.live.get(taskId)!
    clearTimeout(live.approvalTimer)
    // A rejection resumes straight at the model, past the inbox middleware: what the user wrote while
    // the turn waited rides on the last rejection instead (R2.1).
    const reject = live.pending.findLast((p) => p.decision?.type === "reject")
    if (reject?.decision?.type === "reject" && live.inbox.length)
      reject.decision = {
        type: "reject",
        message: `${reject.decision.message ?? "The user rejected this call."}\n\nThe user wrote while you waited: ${this.drainInbox(taskId).join("\n\n")}`,
      }
    const decisions = live.pending.map(({ name, decision }) =>
      decision!.type === "edit" ? { type: "edit" as const, editedAction: { name, args: decision!.args } } : decision!,
    )
    for (const p of live.pending) {
      const patchId = patchOf(p)
      if (patchId && p.decision?.type === "reject") this.rejectQuietly(patchId, taskId)
    }
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

  /** The user's decision on a patch the paused run waits on (specs/orchestrator R3.1, R3.2). */
  decide(taskId: string, patchId: string, decision: "approve" | "reject"): PatchView {
    const slot = this.live.get(taskId)?.pending.find((p) => patchOf(p) === patchId && !p.decision)
    if (!slot) throw new Error("That patch is not waiting for a decision.")
    this.decideTool(taskId, slot.callId, { type: decision })
    return this.deps.log.getPatch(patchId)
  }

  /** Whether a paused turn waits on the user's decision on this patch. */
  waitsOn(taskId: string, patchId: string): boolean {
    return !!this.live.get(taskId)?.pending.some((p) => patchOf(p) === patchId && !p.decision)
  }

  /** Settle one gated call; once every call of the pause is settled, resume the turn with them (specs/chat R4.3, R4.4). */
  decideTool(taskId: string, callId: string, decision: ToolDecision, origin: Origin = "user"): TaskRow {
    const live = this.live.get(taskId)
    const slot = live?.pending.find((p) => p.callId === callId && !p.decision)
    if (!live || !slot) throw new Error("That call is not waiting for a decision.")
    if (decision.type === "edit" && slot.name === APPLY_PATCH) throw new Error("A patch cannot be edited; approve or reject it.")
    slot.decision = decision
    slot.origin = origin
    this.deps.log.append({
      taskId,
      agent: "app",
      kind: "approval.decided",
      summary: origin === "user" ? `You chose to ${decision.type} ${slot.name}` : `${slot.name} ${decision.type}ed (${origin})`,
      payload: { callId, tool: slot.name, patchId: patchOf(slot) ?? undefined, decision, origin },
    })
    if (live.pending.every((p) => p.decision)) void this.resume(taskId)
    return this.deps.log.getTask(taskId)
  }

  /** The user's next message: a new turn on the task's thread, resumed from the checkpointer (specs/chat R1.1, R1.2). */
  sendMessage(taskId: string, message: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live) {
      if (!REOPENABLE.includes(task.state) && task.state !== "awaiting-user") throw new Error(`The task is ${task.state}.`)
      const opened = this.reopen(taskId)
      this.deps.log.updateTask(taskId, { state: "running", error: "" })
      this.userMessage(taskId, message)
      opened.run = this.fromCheckpoint(taskId, opened, message)
      return this.deps.log.getTask(taskId)
    }
    if (["pending", "running", "waiting"].includes(task.state)) {
      // The orchestrator reads it before its next model call; a running delegation never sees it (R2.1, R2.3).
      live.inbox.push(message)
      this.userMessage(taskId, message)
      return task
    }
    if (task.state === "stopped") {
      // Continue the stopped turn, which reads the message before its next model call.
      live.inbox.push(message)
      this.userMessage(taskId, message)
      return this.continueTurn(taskId)
    }
    if (task.state !== "awaiting-user") throw new Error(`The task is ${task.state}.`)
    this.newTurn(live)
    this.deps.log.updateTask(taskId, { state: "running" })
    this.userMessage(taskId, message)
    // The new turn opens on this message, so the orchestrator reads it at once (R2.2).
    this.deps.log.append({ taskId, agent: "orchestrator", kind: "message.read", summary: "Read your message", payload: { output: message } })
    live.run = this.drive(taskId, { messages: [new HumanMessage(message)] }, live.callbacks)
    return this.deps.log.getTask(taskId)
  }

  /** A fresh abort signal for the next turn, and the previous turn's stream disowned. */
  private newTurn(live: Live) {
    live.turnNo++
    live.asked = 0
    live.abort = new AbortController()
    live.ctx.signal = live.abort.signal
  }

  /**
    Stop the running turn without ending the task (specs/chat R3.1): abort its model call and every
    running delegation, reject the gated calls still waiting, and mark it stopped at once — whether or
    not the stream observes the abort, whose outcome is then ignored (R3.3).
  */
  stopTurn(taskId: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live || !["running", "waiting", "pending"].includes(task.state)) throw new Error(`The task is ${task.state}, not running.`)
    live.abort.abort()
    live.turnNo++
    clearTimeout(live.approvalTimer)
    for (const p of live.pending) {
      if (p.decision) continue
      const decision: ToolDecision = { type: "reject", message: STOPPED }
      Object.assign(p, { decision, origin: "stopped" })
      this.deps.log.append({
        taskId,
        agent: "app",
        kind: "approval.decided",
        summary: `${p.name} rejected (stopped)`,
        payload: { callId: p.callId, tool: p.name, patchId: patchOf(p) ?? undefined, decision, origin: "stopped" },
      })
    }
    // The aborted delegations record their end when their containers stop; the stop is now.
    for (const s of this.deps.log.steps(taskId)) if (s.kind === "delegation" && s.state === "running") this.deps.log.updateStep(s.id, { state: "cancelled" })
    this.deps.log.updateTask(taskId, { state: "stopped" })
    this.deps.log.append({ taskId, agent: "app", kind: "turn.stopped", state: "stopped", summary: "You stopped the turn", payload: {} })
    return this.deps.log.getTask(taskId)
  }

  /** Continue a stopped turn from the checkpoint, once the stopped stream has wound down or the grace has passed (R3.2). */
  continueTurn(taskId: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live || task.state !== "stopped") throw new Error(`The task is ${task.state}, not stopped.`)
    const previous = live.run
    this.newTurn(live)
    this.deps.log.updateTask(taskId, { state: "running" })
    this.deps.log.append({ taskId, agent: "app", kind: "turn.continued", state: "running", summary: "You continued the turn", payload: {} })
    live.run = (async () => {
      await Promise.race([previous, new Promise((res) => setTimeout(res, this.deps.stopGraceMs ?? STOP_GRACE_MS))])
      if (live.pending.length) return this.resume(taskId)
      const { agent } = await live.ready
      const snap = await (agent as unknown as { getState(c: unknown): Promise<{ next?: string[] }> }).getState({ configurable: { thread_id: taskId } })
      // Null input resumes the thread's pending step; a thread with none left takes a nudge instead.
      return this.drive(taskId, snap.next?.length ? null : { messages: [new HumanMessage("Continue.")] }, live.callbacks)
    })()
    return this.deps.log.getTask(taskId)
  }

  /**
    Where the conversation stands, from the checkpointer rather than the stored state, so a reopened
    task shows it (specs/chat R1.5): running while a turn streams, waiting on an interrupt, stopped
    with work left on the thread, otherwise awaiting the user. Undefined without a run here.
  */
  async turn(taskId: string): Promise<TaskState | undefined> {
    const live = this.live.get(taskId)
    if (!live) return undefined
    if (live.questions.size) return "waiting"
    if (live.streaming > 0) return "running"
    const { agent } = await live.ready
    const snap = await (agent as unknown as { getState(c: unknown): Promise<{ next?: string[]; tasks?: { interrupts?: unknown[] }[] }> }).getState({
      configurable: { thread_id: taskId },
    })
    if (live.pending.some((p) => !p.decision) || (snap.tasks ?? []).some((t) => t.interrupts?.length)) return "waiting"
    if (snap.next?.length) return "stopped"
    return "awaiting-user"
  }

  /**
    Put a question to the user and wait (specs/chat R5.1, R5.4, R5.5): the user's answer, or the
    default once the question times out, the turn is stopped, or the turn has asked its cap.
  */
  ask(taskId: string, question: Question, agent: "orchestrator" | "specialist", stepId?: string): Promise<{ answer: Answer; origin: Origin }> {
    const live = this.live.get(taskId)
    const { log } = this.deps
    if (!live || live.abort.signal.aborted) return Promise.resolve({ answer: question.default, origin: "stopped" })
    if (live.asked >= QUESTION_CAP) {
      log.append({
        taskId,
        stepId,
        agent,
        kind: "question.capped",
        summary: `Question limit reached; used the default`,
        payload: { question, answer: question.default, origin: "cap" },
      })
      return Promise.resolve({ answer: question.default, origin: "cap" })
    }
    live.asked++
    const questionId = randomUUID()
    const signal = live.abort.signal
    log.append({ taskId, stepId, agent, kind: "question.asked", summary: question.prompt.slice(0, 200), payload: { questionId, question, agent } })
    log.updateTask(taskId, { state: "waiting" })
    return new Promise((resolve) => {
      const settle = (answer: Answer, origin: Origin) => {
        if (!live.questions.delete(questionId)) return
        clearTimeout(timer)
        signal.removeEventListener("abort", stopped)
        log.append({
          taskId,
          stepId,
          agent: origin === "user" ? "app" : agent,
          kind: "question.answered",
          summary: `${String(answer).slice(0, 120)} (${origin})`,
          payload: { questionId, answer, origin },
        })
        if (!live.questions.size && !live.pending.some((p) => !p.decision) && log.getTask(taskId).state === "waiting")
          log.updateTask(taskId, { state: "running" })
        resolve({ answer, origin })
      }
      const timer = setTimeout(() => settle(question.default, "timeout"), this.deps.settings().questionTimeoutMinutes * 60_000)
      timer.unref?.()
      const stopped = () => settle(question.default, "stopped")
      signal.addEventListener("abort", stopped, { once: true })
      live.questions.set(questionId, { question, settle })
    })
  }

  /** The user's answer to a waiting question, checked against its kind (R5.3, R5.4). */
  answerQuestion(taskId: string, questionId: string, answer: Answer): TaskRow {
    const waiting = this.live.get(taskId)?.questions.get(questionId)
    if (!waiting) throw new Error("That question is not waiting for an answer.")
    waiting.settle(checkAnswer(waiting.question, answer), "user")
    return this.deps.log.getTask(taskId)
  }

  /** End a conversation that waits for the user, and take its container down. */
  close(taskId: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live || !["awaiting-user", "stopped"].includes(task.state))
      throw new Error(`The task is ${task.state}; only a conversation waiting for you can be closed.`)
    this.deps.log.updateTask(taskId, { state: "done" })
    this.deps.log.append({ taskId, agent: "app", kind: "task.done", state: "done", summary: "Conversation closed", payload: { output: task.result } })
    void this.end(taskId)
    return this.deps.log.getTask(taskId)
  }

  /** Abort the model call and every running delegation (R3.4). */
  cancel(taskId: string): TaskRow {
    const live = this.live.get(taskId)
    const task = this.deps.log.getTask(taskId)
    if (!live || !["running", "waiting", "pending", "stopped"].includes(task.state)) throw new Error(`The task is ${task.state}, not running.`)
    live.abort.abort()
    // Nothing streams while waiting or stopped to record the outcome: settle it here.
    if (task.state === "waiting" || task.state === "stopped") {
      live.turnNo++
      for (const p of live.pending) {
        const patchId = patchOf(p)
        if (patchId) this.rejectQuietly(patchId, taskId)
      }
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
    // A task runs its calls without asking unless it was started with gates; one from before that choice existed runs without (specs/chat R4.1).
    const { auto, gated } = this.startedWith(taskId)
    return this.start({ request: t.request, sourceRoot: t.sourceRoot, projectId: t.projectId, gated, auto })
  }

  /**
    Delete a task and everything it kept (specs/task-persistence R4): refused while a turn runs; otherwise its
    run ends, its containers go, then its conversation, patches, records and folder.
  */
  async remove(taskId: string): Promise<void> {
    const task = this.deps.log.getTask(taskId)
    if (["pending", "running", "waiting"].includes(task.state)) throw new Error(`The task is ${task.state}; cancel it before deleting it.`)
    if (this.deleting.has(taskId)) throw new Error("The task is already being deleted.")
    // From here no reopen may bring the task back up.
    this.deleting.add(taskId)
    try {
      if (this.live.has(taskId)) await this.end(taskId)
      await this.disposing.get(taskId)
      await this.deps.removeContainers?.(task)
      // Files first: when one cannot go, the task stays, listed and deletable again.
      this.deps.log.deleteTaskFiles(taskId)
      await this.checkpointer.deleteThread(taskId)
      this.deps.log.deleteTask(taskId)
    } finally {
      this.deleting.delete(taskId)
    }
  }

  /** Settles when the task's current turn stops: at its end, at an approval pause, or awaiting the user. */
  async settled(taskId: string): Promise<void> {
    for (;;) {
      const live = this.live.get(taskId)
      if (!live) return
      const run = live.run
      await run
      if (this.live.get(taskId)?.run === run) return
    }
  }

  /** Forget a task's run and take its workspace down, once it is up if it is still starting. */
  private end(taskId: string): Promise<void> {
    const live = this.live.get(taskId)
    this.live.delete(taskId)
    clearTimeout(live?.approvalTimer)
    const done = live ? live.ready.then(({ ws }) => ws.dispose()).catch(() => undefined) : Promise.resolve()
    this.disposals.add(done)
    this.disposing.set(taskId, done)
    void done.finally(() => {
      this.disposals.delete(done)
      if (this.disposing.get(taskId) === done) this.disposing.delete(taskId)
    })
    return done
  }

  /** Abort every run and resolve once every workspace is down, e.g. before the app quits. */
  async stopAll(): Promise<void> {
    const runs = [...this.live.values()].map((l) => l.run)
    for (const [id, l] of [...this.live]) {
      l.abort.abort()
      void this.end(id)
    }
    // The aborted runs still record their outcome; the database must outlive them.
    await Promise.allSettled(runs)
    await Promise.all([...this.disposals])
  }
}
