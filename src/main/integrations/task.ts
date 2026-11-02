import { z } from "zod"
import type { Answer, Origin, Question } from "@shared/chat"
import { integrationSettings, type IntegrationTool } from "@shared/integrations"
import type { Settings } from "@shared/types"
import type { EventLog } from "../events/log"
import { TaskApprovals } from "./approval"
import type { CallOutcome, IntegrationGate } from "./gate"
import type { HostIntegration, IntegrationRegistry } from "./registry"

/*
  One task's view of the integrations (specs/mcp-integrations R3, R4, R5): its approved targets, the tools each agent
  has, the orchestrator's calls, and what a delegation offers the specialist.
*/

export interface TaskIntegrationsDeps {
  taskId: string
  gate: IntegrationGate
  registry: IntegrationRegistry
  /** sandbox/mcp/server.mjs, copied into each delegation's run directory that offers an integration */
  serverScript: string
  log: EventLog
  settings: () => Settings
  /** puts a question to the user, never to a model, outside the turn's cap */
  ask(q: Question, stepId?: string): Promise<{ answer: Answer; origin: Origin }>
}

/** What a delegation offers the specialist of one integration. */
export interface OfferedIntegration {
  id: string
  title: string
  tools: IntegrationTool[]
  targetDescription?: string
  /** the approved target, and what identifies it, when the delegation named one */
  target?: unknown
  described?: string
}

/** A tool's MCP listing: its name, description and arguments as JSON Schema. */
export function mcpListing(tools: IntegrationTool[]) {
  return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) })) }
}

export class TaskIntegrations {
  readonly approvals: TaskApprovals

  constructor(readonly d: TaskIntegrationsDeps) {
    this.approvals = new TaskApprovals({ taskId: d.taskId, log: d.log, registry: d.registry, settings: d.settings, ask: d.ask })
  }

  /** The integrations that are on and have a target tool for the specialist: what `delegate_to_specialist` can name. */
  async targetable(): Promise<HostIntegration[]> {
    return (await this.d.gate.checked("specialist")).filter((c) => c.host.info.targetSchema && c.tools.some((t) => t.target)).map((c) => c.host)
  }

  orchestratorTools() {
    return this.d.gate.checked("orchestrator")
  }

  /** Approves each target a delegation names, asking the user for those the task has not approved: true, or the refusal. */
  async approveTargets(targets: Record<string, unknown>): Promise<true | string> {
    for (const [integration, target] of Object.entries(targets)) {
      const host = this.d.registry.get(integration)
      if (!host) return `There is no integration ${integration}.`
      if (!integrationSettings(host.info, this.d.settings().integrations).enabled) return `${host.info.title} is off in Settings.`
      const ok = await this.approvals.approve({ integration, target, agent: "specialist" })
      if (ok !== true) return ok
    }
    return true
  }

  /** An orchestrator's call: a target it names is approved first, by the user, every time the task has not (R3.2). */
  async callAsOrchestrator(integration: string, tool: string, args: Record<string, unknown>, target?: unknown): Promise<CallOutcome> {
    // A target is put to the user only for a call the gate would let through.
    if (target !== undefined && !(await this.d.gate.refusal(integration, tool, "orchestrator"))) {
      const ok = await this.approvals.approve({ integration, target, agent: "orchestrator" })
      if (ok !== true) {
        this.d.log.append({
          taskId: this.d.taskId,
          agent: "orchestrator",
          kind: "integration.call",
          summary: `${integration}.${tool}: refused: target not approved`,
          payload: { agent: "orchestrator", integration, tool, arguments: args, target, outcome: `refused: ${ok}`, bytes: 0 },
        })
        return { error: ok }
      }
    }
    return this.d.gate.call({ taskId: this.d.taskId, agent: "orchestrator", integration, tool, args, target }, this.approvals)
  }

  /**
    What a delegation offers the specialist: each integration that is on with tools checked for it, a target tool
    only where the delegation names an approved target. A named integration that is disconnected, or whose target
    cannot be opened, is the delegation's error (R4.5).
  */
  async forDelegation(targets: Record<string, unknown>): Promise<OfferedIntegration[] | { error: string }> {
    for (const [integration, target] of Object.entries(targets)) {
      const host = this.d.registry.get(integration)
      if (!host) return { error: `There is no integration ${integration}.` }
      const config = integrationSettings(host.info, this.d.settings().integrations).config
      if (!(await host.connected(config))) return { error: `${host.info.title} is not connected: open it, or check it in Settings, and delegate again.` }
      try {
        await this.d.gate.open(this.d.taskId, integration, target, this.approvals)
      } catch (e) {
        return { error: `${host.info.title} could not open the target: ${(e as Error).message}` }
      }
    }
    return (await this.d.gate.checked("specialist"))
      .map(({ host, tools }) => {
        const target = targets[host.info.id]
        return {
          id: host.info.id,
          title: host.info.title,
          tools: tools.filter((t) => !t.target || target !== undefined),
          ...(host.info.targetDescription ? { targetDescription: host.info.targetDescription } : {}),
          ...(target !== undefined ? { target, described: this.approvals.described(host.info.id, target) } : {}),
        }
      })
      .filter((o) => o.tools.length)
  }

  /** A call the specialist wrote to the run channel, checked as the specialist's against the delegation's targets (R4.3). */
  async fromSpecialist(body: unknown, offered: OfferedIntegration[], stepId: string): Promise<CallOutcome> {
    const parsed = SpecialistCall.safeParse(body)
    if (!parsed.success) return { error: "The tool call is invalid." }
    const { integration, tool, arguments: args } = parsed.data
    const o = offered.find((x) => x.id === integration)
    if (!o) return { error: `${integration} is not offered to this delegation.` }
    return this.d.gate.call({ taskId: this.d.taskId, stepId, agent: "specialist", integration, tool, args, target: o.target }, this.approvals)
  }
}

const SpecialistCall = z
  .object({
    integration: z.string().max(64),
    tool: z.string().max(64),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict()
