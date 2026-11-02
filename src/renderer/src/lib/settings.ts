/*
  The Settings view's sections, in the order of its tabs (specs/desktop-ui R1.4): one tab each, one shown at a time.
*/

export const SETTINGS_SECTIONS = [
  { id: "model", label: "Orchestrator model" },
  { id: "sandbox", label: "Sandbox" },
  { id: "specialist", label: "Specialist" },
  { id: "mcp", label: "MCP integrations" },
  { id: "loop", label: "You in the loop" },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"]

/** The tab Settings opens on. */
export const FIRST_SECTION: SettingsSection = SETTINGS_SECTIONS[0].id
