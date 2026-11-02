import type { IntegrationAgent, IntegrationSettings, IntegrationStatus, IntegrationView } from "@shared/integrations"

/*
  The MCP tab's data (specs/mcp-integrations R1.1, R1.4, R2.1–R2.3): each integration's row in the list, and on its page
  each tool's row with one toggle per agent, its defaults where the user chose nothing, and the warning on a target
  tool turned on for the orchestrator.
*/

export interface ToolRow {
  name: string
  description: string
  target: boolean
  orchestrator: boolean
  specialist: boolean
  /** what it returns goes to the orchestrator's model and provider (R2.3) */
  warn: boolean
}

/** An integration's settings, or its defaults: off, its config empty, every tool at its default. */
export function settingsOf(view: IntegrationView, stored: Record<string, IntegrationSettings> | undefined): IntegrationSettings {
  return stored?.[view.id] ?? { enabled: false, config: {}, tools: {} }
}

export function toolRows(view: IntegrationView, s: IntegrationSettings): ToolRow[] {
  return view.tools.map((t) => {
    const c = s.tools[t.name] ?? { orchestrator: t.orchestratorDefault, specialist: true }
    return { name: t.name, description: t.description, target: t.target, ...c, warn: t.target && c.orchestrator }
  })
}

/** What the MCP tab's list shows of an integration's connection: only while it is on, and once its status came (R1.4). */
export type Connection = "off" | "checking" | "connected" | "not connected"

/** One integration as the MCP tab lists it (R1.1, R1.4). */
export interface IntegrationRow {
  id: string
  title: string
  description: string
  on: boolean
  connection: Connection
}

export function integrationRow(view: IntegrationView, s: IntegrationSettings, status?: IntegrationStatus): IntegrationRow {
  const connection: Connection = !s.enabled ? "off" : !status ? "checking" : status.connected ? "connected" : "not connected"
  return { id: view.id, title: view.title, description: view.description, on: s.enabled, connection }
}

/** The settings with one tool's choice changed for one agent; its other agent keeps what it showed. */
export function withChoice(view: IntegrationView, s: IntegrationSettings, tool: string, agent: IntegrationAgent, value: boolean): IntegrationSettings {
  const row = toolRows(view, s).find((r) => r.name === tool)
  if (!row) return s
  return { ...s, tools: { ...s.tools, [tool]: { orchestrator: row.orchestrator, specialist: row.specialist, [agent]: value } } }
}
