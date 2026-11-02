import { z } from "zod"

/*
  The contract every MCP integration meets (specs/mcp-integrations R1, R2,
  adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations): what it is, its settings, its kind of target and
  its catalog of tools, with the orchestrator's default for each. The app carries the list; nothing here lets a
  server the app does not carry in.
*/

/** The agents an integration's tool can be checked for. */
export type IntegrationAgent = "orchestrator" | "specialist"

/** One tool of an integration's catalog. */
export interface IntegrationTool {
  /** the tool's name inside its integration; the agents see it as `toolName(id, name)` */
  name: string
  description: string
  /** its arguments, held strict so the container cannot pass a target or anything else the catalog does not name */
  schema: z.ZodObject<z.ZodRawShape>
  /** whether it works on a target, which the user approves (R3) */
  target: boolean
  /** whether it starts checked for the orchestrator (R2.2) */
  orchestratorDefault: boolean
}

/** One setting of an integration, as the Settings view shows it. */
export interface IntegrationField {
  key: string
  label: string
  hint?: string
}

/** Something the user can ask an integration to do from Settings, such as installing its bridge. */
export interface IntegrationAction {
  id: string
  label: string
  description: string
}

export interface IntegrationInfo {
  /** the MCP server's name, kebab-case: the agents see its tools under `mcp__<id>__` */
  id: string
  title: string
  description: string
  /** the settings' schema, and their values before the user changes any */
  settingsSchema: z.ZodObject<z.ZodRawShape>
  defaultConfig: Record<string, unknown>
  fields: IntegrationField[]
  /** the schema of one target, when its tools work on one */
  targetSchema?: z.ZodType
  /** what a target is, in a sentence the agents read */
  targetDescription?: string
  actions: IntegrationAction[]
  tools: IntegrationTool[]
}

/** Which agents one tool is checked for. */
export interface ToolChoice {
  orchestrator: boolean
  specialist: boolean
}

/** What the user chose for one integration; a tool with no entry takes the defaults of R2.2. */
export interface IntegrationSettings {
  enabled: boolean
  config: Record<string, unknown>
  tools: Record<string, ToolChoice>
}

export const ToolChoiceSchema = z.object({ orchestrator: z.boolean(), specialist: z.boolean() }).strict()

export const IntegrationSettingsSchema = z
  .object({
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    tools: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), ToolChoiceSchema),
  })
  .strict()

/** An integration's id: kebab-case, short enough for a tool name a provider accepts. */
export const IntegrationIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/)

/** The one name both agents know a tool by (R5.1). */
export function toolName(id: string, tool: string): string {
  return `mcp__${id}__${tool}`
}

/** The tools' prefix Claude Code allows them all by. */
export function toolPrefix(id: string): string {
  return `mcp__${id}`
}

/** An integration's settings before the user chose anything: off, its default config, every tool at its default. */
export function defaultIntegrationSettings(info: IntegrationInfo): IntegrationSettings {
  return { enabled: false, config: { ...info.defaultConfig }, tools: {} }
}

/** The stored settings of an integration over its defaults. */
export function integrationSettings(info: IntegrationInfo, stored: Record<string, IntegrationSettings> | undefined): IntegrationSettings {
  const s = stored?.[info.id]
  const d = defaultIntegrationSettings(info)
  return s ? { enabled: s.enabled, config: { ...d.config, ...s.config }, tools: { ...s.tools } } : d
}

/** Which agents a tool is checked for: the user's choice, else every specialist box and the orchestrator's default (R2.2). */
export function toolChoice(tool: IntegrationTool, s: IntegrationSettings): ToolChoice {
  return s.tools[tool.name] ?? { orchestrator: tool.orchestratorDefault, specialist: true }
}

/** The tools of an integration that is on and checked for an agent; none while it is off. */
export function checkedTools(tools: IntegrationTool[], s: IntegrationSettings, agent: IntegrationAgent): IntegrationTool[] {
  return s.enabled ? tools.filter((t) => toolChoice(t, s)[agent]) : []
}

/** One integration as the renderer sees it: no schema crosses IPC. */
export interface IntegrationView {
  id: string
  title: string
  description: string
  fields: IntegrationField[]
  actions: IntegrationAction[]
  targetDescription?: string
  tools: { name: string; description: string; target: boolean; orchestratorDefault: boolean }[]
}

/** One check an integration runs before it is turned on, and the step that fixes it when it fails (R1.2, R1.3). */
export interface IntegrationCheck {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export interface IntegrationStatus {
  id: string
  enabled: boolean
  checks: IntegrationCheck[]
  connected: boolean
}

/** What an action did; a failed one may name the files to move by hand (specs/cheat-engine R1.4). */
export interface IntegrationActionResult {
  ok: boolean
  message: string
  paths?: { label: string; path: string }[]
}

/** A stable key for a target, so the same target approved twice is one approval. */
export function targetKey(target: unknown): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
        )
      : Array.isArray(v)
        ? v.map(sort)
        : v
  return JSON.stringify(sort(target))
}
