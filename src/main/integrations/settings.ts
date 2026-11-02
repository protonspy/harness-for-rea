import { integrationSettings, type IntegrationSettings, type IntegrationStatus } from "@shared/integrations"
import type { Settings } from "@shared/types"
import type { IntegrationRegistry } from "./registry"

/*
  An integration's settings as Settings saves them (specs/mcp-integrations R1.1–R1.5): only an integration the app
  carries, its config held to its schema, its tools to its catalog; turning one on runs its checks, and a failed
  check leaves it off.
*/

/** The integrations a save leaves, each checked: an id the app does not carry, or a tool off its catalog, is refused. */
export async function saveIntegrations(
  registry: IntegrationRegistry,
  current: Settings,
  patch: Record<string, IntegrationSettings>,
): Promise<Record<string, IntegrationSettings>> {
  const next = { ...current.integrations }
  for (const [id, wanted] of Object.entries(patch)) {
    const host = registry.get(id)
    if (!host) throw new Error(`There is no integration ${id}; Settings offers only the ones the app carries.`)
    const config = host.info.settingsSchema.parse({ ...host.info.defaultConfig, ...wanted.config })
    const catalog = new Set((await host.catalog(config)).map((t) => t.name))
    const unknown = Object.keys(wanted.tools).filter((t) => !catalog.has(t))
    if (unknown.length) throw new Error(`${host.info.title} has no tool ${unknown.join(", ")}.`)
    const was = integrationSettings(host.info, current.integrations).enabled
    // Turning it on runs its checks; one that fails keeps it off, and the view shows which (R1.2, R1.3).
    const enabled = wanted.enabled && (was || (await host.checks(config)).every((c) => c.ok))
    next[id] = { enabled, config, tools: wanted.tools }
  }
  return next
}

/** An integration's checks, and whether it is connected (R1.2–R1.4). */
export async function integrationStatus(registry: IntegrationRegistry, settings: Settings, id: string): Promise<IntegrationStatus> {
  const host = registry.get(id)
  if (!host) throw new Error(`There is no integration ${id}.`)
  const s = integrationSettings(host.info, settings.integrations)
  const checks = await host.checks(s.config)
  return { id, enabled: s.enabled, checks, connected: checks.every((c) => c.ok) && (await host.connected(s.config)) }
}
