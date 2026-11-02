import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { Settings } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { EventLog } from "../src/main/events/log"
import { IntegrationGate } from "../src/main/integrations/gate"
import { IntegrationRegistry } from "../src/main/integrations/registry"
import { TaskIntegrations } from "../src/main/integrations/task"
import { integrationInstructions, ORCHESTRATOR_TOOLS, systemPrompt } from "../src/main/orchestrator/agent"
import { DELEGATE, delegateTool, INTEGRATION_ANSWER_CAP, integrationTool, type ToolContext } from "../src/main/orchestrator/tools"
import { fakeIntegration } from "./fixtures/fake-integration"

/* specs/mcp-integrations R3.1–R3.3, R5: the orchestrator's integration tools, its delegation targets and its instructions. */

let dir: string
let log: EventLog
let taskId: string
let settings: Settings
let fake: ReturnType<typeof fakeIntegration>
let answers: boolean[]
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hfr-integ-orch-"))
  openDb(join(dir, "hfr.db"))
  log = new EventLog(dir)
  taskId = log.createTask({ request: "r", sourceRoot: dir, model: "m" }).id
  settings = { ...DEFAULT_SETTINGS, integrations: { fake: { enabled: true, config: {}, tools: {} } } }
  fake = fakeIntegration()
  answers = []
  const registry = new IntegrationRegistry([fake])
  const integrations = new TaskIntegrations({
    taskId,
    gate: new IntegrationGate({ registry, settings: () => settings, log }),
    registry,
    serverScript: "",
    log,
    settings: () => settings,
    ask: async () => ({ answer: answers.shift() ?? false, origin: "user" }),
  })
  ctx = {
    deps: { log, dataDir: dir, launcher: { preflight: async () => "no docker here", launch: () => ({ command: "x", args: [] }) }, settings: () => settings },
    taskId,
    sourceRoot: dir,
    root: "/",
    signal: new AbortController().signal,
    integrations,
    targetable: [fake.info],
  }
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const info = () => fake.info
const tool = (name: string) =>
  integrationTool(
    ctx,
    info(),
    info().tools.find((t) => t.name === name)!,
  )

describe("the orchestrator's integration tools (R5.1)", () => {
  it("names each tool as the specialist sees it, and calls it through the gate as the orchestrator's", async () => {
    const list = tool("list")
    expect(list.name).toBe("mcp__fake__list")
    expect(JSON.parse(await list.invoke({}))).toMatchObject({ tool: "list" })
    expect(log.history(taskId).events.find((e) => e.kind === "integration.call")?.payload).toMatchObject({ agent: "orchestrator", outcome: "ok" })
  })

  it("takes a target tool's target as an argument and has the user approve it first (R3.2)", async () => {
    settings = { ...settings, integrations: { fake: { enabled: true, config: {}, tools: { lookup: { orchestrator: true, specialist: true } } } } }
    answers = [true]
    const out = JSON.parse(await tool("lookup").invoke({ key: "k", target: { name: "t1" } }))
    expect(out).toMatchObject({ target: { name: "t1" }, args: { key: "k" } })
  })

  it("ends with the refusal when the user declines the target (R3.3)", async () => {
    settings = { ...settings, integrations: { fake: { enabled: true, config: {}, tools: { lookup: { orchestrator: true, specialist: true } } } } }
    answers = [false]
    expect(await tool("lookup").invoke({ key: "k", target: { name: "t1" } })).toMatch(/^ERROR: The user declined/)
    expect(fake.opened).toEqual([])
    expect(log.history(taskId).events.find((e) => e.kind === "integration.call")?.payload.outcome).toMatch(/^refused/)
  })

  it("asks for no target on a tool the orchestrator may not call", async () => {
    answers = [true]
    expect(await tool("lookup").invoke({ key: "k", target: { name: "t1" } })).toBe("ERROR: lookup is not allowed for the orchestrator in Settings.")
    expect(answers).toEqual([true])
  })

  it("cuts an answer past its cap and says so", async () => {
    fake.call = async () => ({ big: "x".repeat(INTEGRATION_ANSWER_CAP) })
    const out = await tool("list").invoke({})
    expect(out.length).toBeLessThan(INTEGRATION_ANSWER_CAP + 200)
    expect(out).toMatch(/\[cut at 65536 of \d+ characters/)
  })

  it("leaves the fixed allowlist alone: the integration tools are added per task", () => {
    expect(ORCHESTRATOR_TOOLS.has("mcp__fake__list")).toBe(false)
  })
})

describe("delegating with a target (R3.1–R3.3)", () => {
  it("offers `targets` keyed by the integrations a delegation can name", () => {
    const schema = delegateTool(ctx).schema as unknown as { safeParse(v: unknown): { success: boolean } }
    const pkg = { brief: "b", objective: "o", files: ["a.ts"] }
    expect(schema.safeParse({ ...pkg, targets: { fake: { name: "t1" } } }).success).toBe(true)
    expect(schema.safeParse({ ...pkg, targets: { other: { name: "t1" } } }).success).toBe(false)
    expect(schema.safeParse({ ...pkg, targets: { fake: { pid: 1 } } }).success).toBe(false)
  })

  it("has no `targets` when no integration can take one", () => {
    const schema = delegateTool({ ...ctx, targetable: [] }).schema as unknown as { safeParse(v: unknown): { success: boolean } }
    expect(schema.safeParse({ brief: "b", objective: "o", files: ["a.ts"], targets: { fake: { name: "t1" } } }).success).toBe(false)
  })

  it("ends the delegation with the refusal when the user declines its target, before anything runs", async () => {
    answers = [false]
    const out = await delegateTool(ctx).invoke({ brief: "b", objective: "o", files: ["a.ts"], targets: { fake: { name: "t1" } } })
    expect(out).toMatch(/^REFUSED: The user declined/)
    expect(log.steps(taskId)).toEqual([])
  })
})

describe("the orchestrator's instructions (R5.2)", () => {
  it("names the integration's tools and says a target's analysis is delegated with that target", () => {
    const [line] = integrationInstructions([
      { id: "cheat-engine", title: "Cheat Engine", tools: ["mcp__cheat-engine__status"], targets: true, targetDescription: "one process" },
    ])
    expect(line).toContain("mcp__cheat-engine__status")
    expect(line).toContain(`call ${DELEGATE} with \`targets: {"cheat-engine": …}\``)
    expect(systemPrompt("/workspace", undefined, {}, [{ id: "fake", title: "Fake", tools: [], targets: true }])).toContain("Integrations on the user's machine")
    expect(systemPrompt("/workspace")).not.toContain("Integrations on the user's machine")
  })
})
