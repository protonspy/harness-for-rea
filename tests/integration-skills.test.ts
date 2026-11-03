import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CHEAT_ENGINE_TOOLS } from "../src/shared/cheatengine"
import { IDA_PRO_TOOLS } from "../src/shared/idapro"
import { cheatEngine } from "../src/main/cheatengine/integration"
import { idaPro } from "../src/main/idapro/integration"

/* specs/mcp-integrations R4.7: each integration the app carries has a skill, and it names only tools of its catalog. */

const SANDBOX = join(import.meta.dirname, "..", "sandbox")
const hosts = [
  { host: cheatEngine({ script: join(SANDBOX, "cheat-engine", "hfr-bridge.lua") }), catalog: CHEAT_ENGINE_TOOLS },
  { host: idaPro({ pluginDir: join(SANDBOX, "ida-pro") }), catalog: IDA_PRO_TOOLS },
]

describe.each(hosts.map((h) => [h.host.info.id, h] as const))("the %s skill (R4.7)", (id, { host, catalog }) => {
  const skill = host.skill ?? ""

  it("is carried by the integration, named after it", () => {
    expect(skill).toMatch(new RegExp(`^---\\nname: ${id}\\ndescription: .+\\n---\\n`))
  })

  it("names only tools of the catalog, by their full names", () => {
    const named = [...skill.matchAll(/mcp__([\w-]+?)__(\w+)/g)].map((m) => ({ integration: m[1], tool: m[2] }))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => n.integration !== id)).toEqual([])
    const tools = new Set(catalog.map((t) => t.name))
    expect(named.filter((n) => !tools.has(n.tool)).map((n) => n.tool)).toEqual([])
  })

  it("starts from the integration's status tool", () => {
    expect(skill).toContain(`mcp__${id}__status`)
  })
})
