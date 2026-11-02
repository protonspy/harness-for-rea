import { describe, expect, it } from "vitest"
import { FIRST_SECTION, SETTINGS_SECTIONS } from "../src/renderer/src/lib/settings"

/* specs/desktop-ui R1.4: Settings in tabs, one per section. */

describe("the Settings view's tabs (R1.4)", () => {
  it("has one tab per section: the orchestrator model, the sandbox, the specialist, the MCP integrations and the waits on the user", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual(["Orchestrator model", "Sandbox", "Specialist", "MCP integrations", "You in the loop"])
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length)
  })

  it("opens on the first section", () => {
    expect(FIRST_SECTION).toBe("model")
  })
})
