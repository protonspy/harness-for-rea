import { checkedTools, integrationSettings, targetKey, toolChoice, type IntegrationAgent } from "@shared/integrations"
import type { Settings } from "@shared/types"
import type { EventLog } from "../events/log"
import type { TaskApprovals } from "./approval"
import type { HostIntegration, IntegrationRegistry, IntegrationSession } from "./registry"

/*
  The one check before every integration call, whichever agent made it (specs/mcp-integrations R2.4, R3.4): the
  integration is one the app carries and is on, the tool is in its catalog and checked for that agent, its arguments
  fit the tool's schema, and a tool that works on a target has the target the task approved. Then the call, bounded
  by the integration's timeout (R4.4), and its record in the event log, never its answer (R6.1).
*/

export interface GateDeps {
  registry: IntegrationRegistry
  settings: () => Settings
  log: EventLog
}

export interface CallRequest {
  taskId: string
  stepId?: string
  agent: IntegrationAgent
  integration: string
  tool: string
  args: unknown
  /** the target the call works on: a delegation's, which the container never names, or the one the orchestrator named */
  target?: unknown
}

export type CallOutcome = { result: unknown } | { error: string }

class Refused extends Error {}

/** A promise bounded by a timeout that answers with the cause. */
export function within<T>(p: Promise<T>, ms: number, cause: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(cause)), ms)
    timer.unref?.()
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

const seconds = (ms: number) => `${ms / 1000} s`

export class IntegrationGate {
  /** each approved target's session, per task, opened on first use or when a delegation starts on it */
  private readonly sessions = new Map<string, Promise<IntegrationSession>>()

  constructor(private readonly d: GateDeps) {}

  /** The integration, if the app carries it and it is on, with its settings. */
  private resolve(id: string): { host: HostIntegration; config: Record<string, unknown>; s: ReturnType<typeof integrationSettings> } {
    const host = this.d.registry.get(id)
    if (!host) throw new Refused(`There is no integration ${id}.`)
    const s = integrationSettings(host.info, this.d.settings().integrations)
    if (!s.enabled) throw new Refused(`${host.info.title} is off in Settings.`)
    return { host, config: s.config, s }
  }

  /** The tools an agent has of every integration that is on. */
  async checked(agent: IntegrationAgent): Promise<{ host: HostIntegration; tools: Awaited<ReturnType<HostIntegration["catalog"]>> }[]> {
    const out = []
    for (const host of this.d.registry.list) {
      const s = integrationSettings(host.info, this.d.settings().integrations)
      if (!s.enabled) continue
      const tools = checkedTools(await host.catalog(s.config), s, agent)
      if (tools.length) out.push({ host, tools })
    }
    return out
  }

  /**
    Opens a target's session afresh, as a delegation does when it starts, so the engine opens the approved target
    again; the task's later calls on that target use it.
  */
  open(taskId: string, integration: string, target: unknown, approvals: TaskApprovals): Promise<IntegrationSession> {
    // No caller opens a target the task has not approved, now or later.
    if (!approvals.has(integration, target)) return Promise.reject(new Refused("The target is not approved for this task."))
    const { host, config } = this.resolve(integration)
    const key = `${taskId}\n${integration}\n${targetKey(target)}`
    const p = within(host.session(config, target), host.timeoutMs, `${host.info.title} did not open the target within ${seconds(host.timeoutMs)}.`)
    this.sessions.set(key, p)
    p.catch(() => this.sessions.get(key) === p && this.sessions.delete(key))
    return p
  }

  /** Why an agent may not call a tool as Settings has it now, or null when it may; the gate checks again on the call. */
  async refusal(integration: string, tool: string, agent: IntegrationAgent): Promise<string | null> {
    try {
      const { host, config, s } = this.resolve(integration)
      const t = (await host.catalog(config)).find((x) => x.name === tool)
      if (!t) return `${host.info.title} has no tool ${tool}.`
      return toolChoice(t, s)[agent] ? null : `${tool} is not allowed for the ${agent} in Settings.`
    } catch (e) {
      return (e as Error).message
    }
  }

  /** Forgets a task's sessions, when the task closes. */
  release(taskId: string): void {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${taskId}\n`)) this.sessions.delete(key)
  }

  async call(req: CallRequest, approvals: TaskApprovals): Promise<CallOutcome> {
    let args: Record<string, unknown> | undefined
    const record = (outcome: string, bytes = 0) =>
      this.d.log.append({
        taskId: req.taskId,
        stepId: req.stepId,
        agent: req.agent,
        kind: "integration.call",
        summary: `${req.integration}.${req.tool}: ${outcome}`.slice(0, 200),
        payload: {
          agent: req.agent,
          integration: req.integration,
          tool: req.tool,
          // Arguments a schema refused are whatever the caller sent: kept short.
          arguments: args ?? (req.args === undefined ? null : JSON.stringify(req.args).slice(0, 2000)),
          target: req.target ?? null,
          outcome,
          bytes,
        },
      })
    try {
      const { host, config, s } = this.resolve(req.integration)
      const tool = (await host.catalog(config)).find((t) => t.name === req.tool)
      if (!tool) throw new Refused(`${host.info.title} has no tool ${req.tool}.`)
      if (!toolChoice(tool, s)[req.agent]) throw new Refused(`${req.tool} is not allowed for the ${req.agent} in Settings.`)
      const parsed = tool.schema.safeParse(req.args ?? {})
      if (!parsed.success)
        throw new Refused(
          `The arguments of ${req.tool} are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}.`,
        )
      args = parsed.data
      const cause = `${host.info.title} did not answer ${req.tool} within ${seconds(host.timeoutMs)}.`
      let result: unknown
      if (tool.target) {
        if (req.target === undefined) throw new Refused(`${req.tool} needs an approved target, and this call has none.`)
        if (!approvals.has(req.integration, req.target)) throw new Refused(`The target of this call is not approved for this task.`)
        const key = `${req.taskId}\n${req.integration}\n${targetKey(req.target)}`
        const session = await (this.sessions.get(key) ?? this.open(req.taskId, req.integration, req.target, approvals))
        result = await within(session.call(req.tool, args), host.timeoutMs, cause)
      } else result = await within(host.call(config, req.tool, args), host.timeoutMs, cause)
      record("ok", JSON.stringify(result ?? null).length)
      return { result }
    } catch (e) {
      const message = (e as Error).message
      record(e instanceof Refused ? `refused: ${message}` : `error: ${message}`)
      return { error: message }
    }
  }
}
