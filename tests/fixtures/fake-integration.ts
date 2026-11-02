import { z } from "zod"
import type { IntegrationInfo } from "../../src/shared/integrations"
import type { HostIntegration } from "../../src/main/integrations/registry"

/* A fake engine for specs/mcp-integrations: one tool that needs a target, and ones that do not (design.md § Testing). */

export const FAKE_INFO: IntegrationInfo = {
  id: "fake",
  title: "Fake",
  description: "A fake engine.",
  settingsSchema: z.object({}).strict(),
  defaultConfig: {},
  fields: [],
  targetSchema: z.object({ name: z.string() }).strict(),
  targetDescription: "one named thing",
  actions: [],
  tools: [
    { name: "lookup", description: "Looks up a key on the target.", schema: z.object({ key: z.string() }).strict(), target: true, orchestratorDefault: false },
    { name: "list", description: "Lists the targets.", schema: z.object({}).strict(), target: false, orchestratorDefault: true },
    { name: "slow", description: "Never answers.", schema: z.object({}).strict(), target: false, orchestratorDefault: false },
    { name: "broken", description: "Always fails.", schema: z.object({}).strict(), target: false, orchestratorDefault: false },
  ],
}

/**
  A fake engine: `lookup` echoes its target, `slow` never answers, `broken` throws; `targets` are the ones that exist,
  and `generation` is each one's identity, which a test bumps to stand for an id reused by another target.
*/
export function fakeIntegration(o: { timeoutMs?: number; connected?: boolean; targets?: string[] } = {}): HostIntegration & {
  opened: string[]
  generation: Map<string, number>
} {
  const opened: string[] = []
  const targets = new Set(o.targets ?? ["t1", "t2"])
  const generation = new Map<string, number>()
  return {
    info: FAKE_INFO,
    opened,
    generation,
    identify: async (_c, t) => {
      const { name } = t as { name: string }
      return targets.has(name) ? `${name}#${generation.get(name) ?? 0}` : null
    },
    timeoutMs: o.timeoutMs ?? 1000,
    checks: async () => [{ name: "ready", ok: o.connected ?? true, detail: "", ...(o.connected === false ? { fix: "start it" } : {}) }],
    connected: async () => o.connected ?? true,
    catalog: async () => FAKE_INFO.tools,
    describeTarget: async (_c, t) => {
      const { name } = t as { name: string }
      if (!targets.has(name)) throw new Error(`There is no ${name}.`)
      return `the thing called ${name}`
    },
    session: async (_c, t) => {
      opened.push((t as { name: string }).name)
      return { call: async (tool, args) => ({ target: t, tool, args, secret: "the answer itself" }) }
    },
    call: async (_c, tool, args) => {
      if (tool === "slow") return new Promise(() => undefined)
      if (tool === "broken") throw new Error("the engine broke")
      return { tool, args, targets: [...targets] }
    },
    runAction: async () => ({ ok: true, message: "done" }),
  }
}
