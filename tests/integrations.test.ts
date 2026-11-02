import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Question } from "../src/shared/chat"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import type { IntegrationSettings } from "../src/shared/integrations"
import type { Settings } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { EventLog } from "../src/main/events/log"
import { APPROVALS_PER_TASK, plain, TaskApprovals } from "../src/main/integrations/approval"
import { IntegrationGate } from "../src/main/integrations/gate"
import { IntegrationRegistry } from "../src/main/integrations/registry"
import { integrationStatus, saveIntegrations } from "../src/main/integrations/settings"
import { integrationRow, settingsOf, toolRows, withChoice } from "../src/renderer/src/lib/integrations"
import { FAKE_INFO, fakeIntegration } from "./fixtures/fake-integration"

/* specs/mcp-integrations: the gate, the approvals and the channel, against a fake integration (design.md § Testing). */

let dir: string
let log: EventLog
let taskId: string
let settings: Settings
let fake: ReturnType<typeof fakeIntegration>
let registry: IntegrationRegistry
let gate: IntegrationGate
let asked: Question[]
let reply: { answer: boolean | string; origin: "user" | "timeout" }

const on = (tools: IntegrationSettings["tools"] = {}): Settings => ({ ...DEFAULT_SETTINGS, integrations: { fake: { enabled: true, config: {}, tools } } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hfr-integrations-"))
  openDb(join(dir, "hfr.db"))
  log = new EventLog(dir, () => undefined)
  taskId = log.createTask({ request: "r", sourceRoot: dir, model: "m" }).id
  settings = on()
  fake = fakeIntegration()
  registry = new IntegrationRegistry([fake])
  gate = new IntegrationGate({ registry, settings: () => settings, log })
  asked = []
  reply = { answer: true, origin: "user" }
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const approvals = () =>
  new TaskApprovals({
    taskId,
    log,
    registry,
    settings: () => settings,
    ask: async (q) => {
      asked.push(q)
      return reply
    },
  })
const calls = () => log.history(taskId).events.filter((e) => e.kind === "integration.call")

describe("the gate (R2.4, R3.4, R4.4, R6.1)", () => {
  it("forwards a specialist's call on its approved target and records it without the answer", async () => {
    const a = approvals()
    expect(await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })).toBe(true)
    const out = await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "lookup", args: { key: "k" }, target: { name: "t1" } }, a)
    expect(out).toEqual({ result: { target: { name: "t1" }, tool: "lookup", args: { key: "k" }, secret: "the answer itself" } })
    const [e] = calls()
    expect(e.agent).toBe("specialist")
    expect(e.payload).toMatchObject({
      agent: "specialist",
      integration: "fake",
      tool: "lookup",
      arguments: { key: "k" },
      target: { name: "t1" },
      outcome: "ok",
    })
    expect(e.payload.bytes).toBe(JSON.stringify((out as { result: unknown }).result).length)
    expect(JSON.stringify(e)).not.toContain("the answer itself")
  })

  it("refuses a tool that is not in the catalog", async () => {
    const out = await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "write", args: {} }, approvals())
    expect(out).toEqual({ error: expect.stringMatching(/has no tool write/) })
    expect(calls()[0].payload.outcome).toMatch(/^refused/)
  })

  it("refuses a tool that is not checked for the calling agent", async () => {
    settings = on({ list: { orchestrator: false, specialist: true } })
    const out = await gate.call({ taskId, agent: "orchestrator", integration: "fake", tool: "list", args: {} }, approvals())
    expect(out).toEqual({ error: expect.stringMatching(/not allowed for the orchestrator/) })
  })

  it("takes the defaults for a tool the user never set: every specialist box, the orchestrator's default", async () => {
    const a = approvals()
    expect(await gate.call({ taskId, agent: "orchestrator", integration: "fake", tool: "list", args: {} }, a)).toHaveProperty("result")
    expect(await gate.call({ taskId, agent: "orchestrator", integration: "fake", tool: "slow", args: {} }, a)).toEqual({
      error: expect.stringMatching(/not allowed/),
    })
  })

  it("refuses every call while the integration is off, and one the app does not carry", async () => {
    settings = { ...DEFAULT_SETTINGS, integrations: { fake: { enabled: false, config: {}, tools: {} } } }
    expect(await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "list", args: {} }, approvals())).toEqual({
      error: expect.stringMatching(/off/),
    })
    expect(await gate.call({ taskId, agent: "specialist", integration: "other", tool: "list", args: {} }, approvals())).toEqual({
      error: expect.stringMatching(/no integration other/),
    })
  })

  it("refuses arguments outside the tool's schema, a target among them", async () => {
    const a = approvals()
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })
    const out = await gate.call(
      { taskId, agent: "specialist", integration: "fake", tool: "lookup", args: { key: "k", target: { name: "t2" } }, target: { name: "t1" } },
      a,
    )
    expect(out).toEqual({ error: expect.stringMatching(/arguments/) })
  })

  it("refuses a target tool with no approved target, or with another target than the approved one", async () => {
    const a = approvals()
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })
    expect(await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "lookup", args: { key: "k" } }, a)).toEqual({
      error: expect.stringMatching(/needs an approved target/),
    })
    expect(await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "lookup", args: { key: "k" }, target: { name: "t2" } }, a)).toEqual({
      error: expect.stringMatching(/not approved/),
    })
    expect(fake.opened).toEqual([])
  })

  it("answers a call the integration does not answer within its timeout with an error naming the cause", async () => {
    fake = fakeIntegration({ timeoutMs: 30 })
    registry = new IntegrationRegistry([fake])
    gate = new IntegrationGate({ registry, settings: () => settings, log })
    const out = await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "slow", args: {} }, approvals())
    expect(out).toEqual({ error: "Fake did not answer slow within 0.03 s." })
    expect(calls()[0].payload.outcome).toMatch(/^error/)
  })

  it("answers an integration's failure with its message", async () => {
    expect(await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "broken", args: {} }, approvals())).toEqual({ error: "the engine broke" })
  })

  it("opens one session per approved target and reuses it", async () => {
    const a = approvals()
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "orchestrator" })
    for (const key of ["a", "b"])
      await gate.call({ taskId, agent: "specialist", integration: "fake", tool: "lookup", args: { key }, target: { name: "t1" } }, a)
    expect(fake.opened).toEqual(["t1"])
  })
})

describe("approving a target (R3.2, R3.3)", () => {
  it("asks the user a yes/no question, default no, showing what identifies the target", async () => {
    const a = approvals()
    expect(await a.approve({ integration: "fake", target: { name: "t1" }, agent: "orchestrator" })).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: "yesno", default: false, prompt: expect.stringContaining("the thing called t1") })
    expect(a.has("fake", { name: "t1" })).toBe(true)
    expect(log.history(taskId).events.find((e) => e.kind === "integration.target")?.payload).toMatchObject({ outcome: "approved" })
  })

  it("asks once per target: an approved one is not asked again, two calls at once share the question", async () => {
    const a = approvals()
    await Promise.all([1, 2].map(() => a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })))
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "orchestrator" })
    expect(asked).toHaveLength(1)
    await a.approve({ integration: "fake", target: { name: "t2" }, agent: "orchestrator" })
    expect(asked).toHaveLength(2)
  })

  it("ends with the refusal when the user declines", async () => {
    reply = { answer: false, origin: "user" }
    const a = approvals()
    expect(await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })).toMatch(/The user declined/)
    expect(a.has("fake", { name: "t1" })).toBe(false)
  })

  it("ends with the refusal when the user does not answer, a yes from the default included", async () => {
    reply = { answer: true, origin: "timeout" }
    expect(await approvals().approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })).toMatch(/did not answer/)
  })

  it("refuses a target that does not exist or does not fit the schema, without asking", async () => {
    const a = approvals()
    expect(await a.approve({ integration: "fake", target: { name: "nope" }, agent: "specialist" })).toBe("There is no nope.")
    expect(await a.approve({ integration: "fake", target: { pid: 1 }, agent: "specialist" })).toMatch(/target is invalid/)
    expect(asked).toEqual([])
  })

  it("keeps a refusal for the task: the same target is not put to the user again", async () => {
    reply = { answer: false, origin: "user" }
    const a = approvals()
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "orchestrator" })
    expect(await a.approve({ integration: "fake", target: { name: "t1" }, agent: "orchestrator" })).toMatch(/The user declined/)
    expect(asked).toHaveLength(1)
  })

  it("asks again when the approved id now names another target, as a reused pid does", async () => {
    const a = approvals()
    await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })
    fake.generation.set("t1", 1)
    expect(await a.approve({ integration: "fake", target: { name: "t1" }, agent: "specialist" })).toBe(true)
    expect(asked).toHaveLength(2)
    expect(log.history(taskId).events.some((e) => e.kind === "integration.target" && e.payload.outcome === "changed")).toBe(true)
  })

  it("puts at most APPROVALS_PER_TASK targets to the user, and refuses the rest without asking", async () => {
    fake = fakeIntegration({ targets: Array.from({ length: APPROVALS_PER_TASK + 1 }, (_, i) => `t${i}`) })
    registry = new IntegrationRegistry([fake])
    reply = { answer: false, origin: "user" }
    const a = approvals()
    for (let i = 0; i < APPROVALS_PER_TASK; i++) await a.approve({ integration: "fake", target: { name: `t${i}` }, agent: "orchestrator" })
    expect(await a.approve({ integration: "fake", target: { name: `t${APPROVALS_PER_TASK}` }, agent: "orchestrator" })).toMatch(/no more are put to them/)
    expect(asked).toHaveLength(APPROVALS_PER_TASK)
  })

  it("shows what identifies a target with no control or direction-changing characters", () => {
    expect(plain("evil‮exe.txt\u0007 (pid 1)")).toBe("evilexe.txt (pid 1)")
  })
})

describe("opening a target", () => {
  it("refuses a target the task has not approved, whoever asks", async () => {
    await expect(gate.open(taskId, "fake", { name: "t1" }, approvals())).rejects.toThrow(/not approved/)
    expect(fake.opened).toEqual([])
  })
})

describe("Settings (R1.1–R1.5, R2.2)", () => {
  it("turns an integration on when its checks pass", async () => {
    const next = await saveIntegrations(registry, { ...DEFAULT_SETTINGS }, { fake: { enabled: true, config: {}, tools: {} } })
    expect(next.fake.enabled).toBe(true)
  })

  it("leaves it off when a check fails, and the status shows the failed check with its fix", async () => {
    registry = new IntegrationRegistry([fakeIntegration({ connected: false })])
    const next = await saveIntegrations(registry, { ...DEFAULT_SETTINGS }, { fake: { enabled: true, config: {}, tools: {} } })
    expect(next.fake.enabled).toBe(false)
    const status = await integrationStatus(registry, { ...DEFAULT_SETTINGS, integrations: next }, "fake")
    expect(status).toEqual({ id: "fake", enabled: false, checks: [{ name: "ready", ok: false, detail: "", fix: "start it" }], connected: false })
  })

  it("refuses an integration the app does not carry, and a tool off its catalog", async () => {
    await expect(saveIntegrations(registry, DEFAULT_SETTINGS, { other: { enabled: false, config: {}, tools: {} } })).rejects.toThrow(
      /only the ones the app carries/,
    )
    await expect(
      saveIntegrations(registry, DEFAULT_SETTINGS, { fake: { enabled: false, config: {}, tools: { write: { orchestrator: true, specialist: true } } } }),
    ).rejects.toThrow(/has no tool write/)
  })

  it("lists every integration the app carries, off by default, with its catalog", async () => {
    const views = await registry.views(() => ({}))
    expect(views.map((v) => [v.id, v.tools.map((t) => [t.name, t.target, t.orchestratorDefault])])).toEqual([
      [
        "fake",
        [
          ["lookup", true, false],
          ["list", false, true],
          ["slow", false, false],
          ["broken", false, false],
        ],
      ],
    ])
    expect(DEFAULT_SETTINGS.integrations).toEqual({})
  })

  it("reports a connected integration once its checks pass", async () => {
    expect((await integrationStatus(registry, settings, "fake")).connected).toBe(true)
  })
})

describe("the MCP section's rows (R2.1–R2.3)", () => {
  const view = {
    id: "fake",
    title: "Fake",
    description: "",
    fields: [],
    actions: [],
    tools: FAKE_INFO.tools.map(({ name, description, target, orchestratorDefault }) => ({ name, description, target, orchestratorDefault })),
  }

  it("starts every specialist box checked and every orchestrator box at the tool's default", () => {
    const rows = toolRows(view, settingsOf(view, {}))
    expect(rows.map((r) => [r.name, r.orchestrator, r.specialist])).toEqual([
      ["lookup", false, true],
      ["list", true, true],
      ["slow", false, true],
      ["broken", false, true],
    ])
  })

  it("warns on a target tool checked for the orchestrator, and only there", () => {
    const s = withChoice(view, settingsOf(view, {}), "lookup", "orchestrator", true)
    expect(s.tools.lookup).toEqual({ orchestrator: true, specialist: true })
    expect(
      toolRows(view, s)
        .filter((r) => r.warn)
        .map((r) => r.name),
    ).toEqual(["lookup"])
  })

  it("lists an integration with its title and whether it is on, its connection only while on (R1.1, R1.4)", () => {
    const off = settingsOf(view, {})
    const enabled = { ...off, enabled: true }
    const status = (connected: boolean) => ({ id: "fake", enabled: true, checks: [], connected })
    expect(integrationRow(view, off, status(true))).toEqual({ id: "fake", title: "Fake", description: "", on: false, connection: "off" })
    expect(integrationRow(view, enabled).connection).toBe("checking")
    expect(integrationRow(view, enabled, status(true)).connection).toBe("connected")
    expect(integrationRow(view, enabled, status(false)).connection).toBe("not connected")
  })

  it("changes one box and keeps the other as it showed", () => {
    const s = withChoice(view, settingsOf(view, {}), "list", "specialist", false)
    expect(s.tools.list).toEqual({ orchestrator: true, specialist: false })
    expect(withChoice(view, s, "nope", "specialist", false)).toBe(s)
  })
})
