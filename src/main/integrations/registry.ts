import type { IntegrationActionResult, IntegrationCheck, IntegrationInfo, IntegrationTool, IntegrationView } from "@shared/integrations"

/*
  The integrations the app carries (specs/mcp-integrations R1.1, R1.5) and the host side of each: its checks, its
  connection, its catalog, what an approval shows of a target, and the calls themselves. Settings offers no way to
  add another (adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations).
*/

/** The calls on one approved target, opened once per delegation or per task. */
export interface IntegrationSession {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>
}

export interface HostIntegration {
  info: IntegrationInfo
  /** how long one call may take before it is answered with an error (R4.4) */
  timeoutMs: number
  /** how to work with its tools, for the specialist while it answers (specs/mcp-integrations R4.7, R4.8) */
  skill?: string
  checks(config: Record<string, unknown>): Promise<IntegrationCheck[]>
  connected(config: Record<string, unknown>): Promise<boolean>
  /** the tools it offers now; static for an engine whose catalog the app carries */
  catalog(config: Record<string, unknown>): Promise<IntegrationTool[]>
  /** what identifies a target to the user approving it; throws when there is no such target */
  describeTarget(config: Record<string, unknown>, target: unknown): Promise<string>
  /** what tells this target apart from another the same id could later name, such as a reused pid; null once it is gone */
  identify?(config: Record<string, unknown>, target: unknown): Promise<string | null>
  /** opens the approved target for calls */
  session(config: Record<string, unknown>, target: unknown): Promise<IntegrationSession>
  /** a tool that works on no target */
  call(config: Record<string, unknown>, tool: string, args: Record<string, unknown>): Promise<unknown>
  runAction(config: Record<string, unknown>, action: string): Promise<IntegrationActionResult>
}

export class IntegrationRegistry {
  private readonly byId: Map<string, HostIntegration>

  constructor(readonly list: HostIntegration[]) {
    this.byId = new Map(list.map((i) => [i.info.id, i]))
  }

  get(id: string): HostIntegration | undefined {
    return this.byId.get(id)
  }

  /** Each integration with its catalog, as the renderer sees it. */
  async views(config: (id: string) => Record<string, unknown>): Promise<IntegrationView[]> {
    return Promise.all(
      this.list.map(async (i) => ({
        id: i.info.id,
        title: i.info.title,
        description: i.info.description,
        fields: i.info.fields,
        actions: i.info.actions,
        ...(i.info.targetDescription ? { targetDescription: i.info.targetDescription } : {}),
        tools: (await i.catalog(config(i.info.id))).map((t) => ({
          name: t.name,
          description: t.description,
          target: t.target,
          orchestratorDefault: t.orchestratorDefault,
        })),
      })),
    )
  }
}
