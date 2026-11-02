import type { Answer, Origin, Question } from "@shared/chat"
import { integrationSettings, targetKey, type IntegrationAgent } from "@shared/integrations"
import type { Settings } from "@shared/types"
import type { EventLog } from "../events/log"
import type { IntegrationRegistry } from "./registry"

/*
  The targets one task approved, per integration (specs/mcp-integrations R3.2, R3.3): a target nobody approved is put
  to the user as a yes/no question, default no, in an automatic task too; a refusal or no answer is the refusal of
  the delegation or call that named it, and stays so for the task.
*/

/** Approval questions one task may put to the user; past them every new target is refused without asking. */
export const APPROVALS_PER_TASK = 20

export interface ApprovalDeps {
  taskId: string
  log: EventLog
  registry: IntegrationRegistry
  settings: () => Settings
  /** puts the question to the user, never to a model; its timeout answers with the default */
  ask(q: Question, stepId?: string): Promise<{ answer: Answer; origin: Origin }>
}

interface Ask {
  integration: string
  target: unknown
  agent: IntegrationAgent
  stepId?: string
}

/** Text an engine read from the OS, shown to the user and the specialist: no control or direction-changing characters. */
export function plain(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").slice(0, 500)
}

export class TaskApprovals {
  /** per integration, each approved target's key, what identified it to the user, and its identity when approved */
  private readonly approved = new Map<string, Map<string, { described: string; identity: string | null }>>()
  /** per integration, each target the user declined or left unanswered, and the refusal it ends with */
  private readonly declined = new Map<string, Map<string, string>>()
  private readonly asking = new Map<string, Promise<true | string>>()
  private asked = 0

  constructor(private readonly d: ApprovalDeps) {}

  has(integration: string, target: unknown): boolean {
    return this.approved.get(integration)?.has(targetKey(target)) ?? false
  }

  /** What identified an approved target to the user. */
  described(integration: string, target: unknown): string | undefined {
    return this.approved.get(integration)?.get(targetKey(target))?.described
  }

  /** True once the user approved the target, now or earlier in the task; otherwise why the call or delegation ends. */
  approve(o: Ask): Promise<true | string> {
    // Two calls naming one target at once ask once.
    const key = `${o.integration}\n${targetKey(o.target)}`
    const pending = this.asking.get(key)
    if (pending) return pending
    const p = this.check(o).finally(() => this.asking.delete(key))
    this.asking.set(key, p)
    return p
  }

  /**
    An approved target stands while it is the same one: a pid Windows handed to another process is not what the user
    approved, so the approval goes and the user is asked again. A target the user declined stays declined in the task.
  */
  private async check(o: Ask): Promise<true | string> {
    const key = targetKey(o.target)
    const declined = this.declined.get(o.integration)?.get(key)
    if (declined) return declined
    const held = this.approved.get(o.integration)?.get(key)
    const host = this.d.registry.get(o.integration)
    if (!held || !host) return this.ask(o)
    if (!host.identify) return true
    const config = integrationSettings(host.info, this.d.settings().integrations).config
    if ((await host.identify(config, o.target).catch(() => null)) === held.identity) return true
    this.approved.get(o.integration)?.delete(key)
    this.d.log.append({
      taskId: this.d.taskId,
      stepId: o.stepId,
      agent: "app",
      kind: "integration.target",
      summary: `${host.info.title}: ${held.described} is no longer the target you approved`,
      payload: { integration: o.integration, target: o.target, described: held.described, agent: o.agent, outcome: "changed" },
    })
    return this.ask(o)
  }

  private async ask(o: Ask): Promise<true | string> {
    const host = this.d.registry.get(o.integration)
    if (!host) return `There is no integration ${o.integration}.`
    const { info } = host
    const parsed = info.targetSchema?.safeParse(o.target)
    if (!parsed) return `${info.title} works on no target.`
    if (!parsed.success)
      return `The ${info.title} target is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "target"} ${i.message}`).join("; ")}.`
    // An agent naming target after target cannot wear the user down with questions.
    if (this.asked >= APPROVALS_PER_TASK)
      return `This task already asked the user about ${APPROVALS_PER_TASK} targets; no more are put to them. Ask the user in your answer which target to use.`
    const config = integrationSettings(info, this.d.settings().integrations).config
    let described: string
    let identity: string | null = null
    try {
      described = plain(await host.describeTarget(config, parsed.data))
      if (host.identify) identity = await host.identify(config, parsed.data)
    } catch (e) {
      return (e as Error).message
    }
    const record = (outcome: string, summary: string) =>
      this.d.log.append({
        taskId: this.d.taskId,
        stepId: o.stepId,
        agent: "app",
        kind: "integration.target",
        summary,
        payload: { integration: o.integration, target: parsed.data, described, agent: o.agent, outcome },
      })
    this.asked++
    const a = await this.d.ask(
      {
        prompt: `Let the agents use ${info.title} on ${described}?`,
        reason: `The ${o.agent} wants ${info.title}'s tools on this target. What they read from it goes to the agents' models and their reports, secrets included, and the specialist's sandbox has full internet access. No is the default; without an answer the ${o.agent === "specialist" ? "delegation" : "call"} is refused.`,
        kind: "yesno",
        default: false,
      },
      o.stepId,
    )
    const key = targetKey(parsed.data)
    if (a.answer === true && a.origin === "user") {
      const targets = this.approved.get(o.integration) ?? new Map<string, { described: string; identity: string | null }>()
      targets.set(key, { described, identity })
      this.approved.set(o.integration, targets)
      record("approved", `${info.title}: you approved ${described}`)
      return true
    }
    const why = a.origin === "user" ? "The user declined" : "The user did not answer, so the default was used:"
    const refusal = `${why} ${info.title} may not be used on ${described} in this task.`
    // A stop answers with the default too, but says nothing about the target: only a real no or no answer is kept.
    if (a.origin === "user" || a.origin === "timeout") {
      const targets = this.declined.get(o.integration) ?? new Map<string, string>()
      targets.set(key, refusal)
      this.declined.set(o.integration, targets)
    }
    record("refused", `${info.title}: ${described} was not approved`)
    return refusal
  }
}
