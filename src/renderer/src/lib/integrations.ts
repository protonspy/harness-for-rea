import type { IntegrationAgent, IntegrationSettings, IntegrationView } from "@shared/integrations"

/*
  The MCP section's data (specs/mcp-integrations R2.1–R2.3): each tool's row with one checkbox per agent, its defaults
  where the user chose nothing, and the warning on a target tool checked for the orchestrator.
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

/** The settings with one checkbox changed; the tool's other box keeps what it showed. */
export function withChoice(view: IntegrationView, s: IntegrationSettings, tool: string, agent: IntegrationAgent, value: boolean): IntegrationSettings {
  const row = toolRows(view, s).find((r) => r.name === tool)
  if (!row) return s
  return { ...s, tools: { ...s.tools, [tool]: { orchestrator: row.orchestrator, specialist: row.specialist, [agent]: value } } }
}
