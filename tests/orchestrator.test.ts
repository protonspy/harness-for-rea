import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, PRESET_MODEL } from "../src/shared/defaults"
import type { Settings } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { EventLog } from "../src/main/events/log"
import { dockerLauncher, type Launcher } from "../src/main/delegation"
import { claudeArgs } from "../src/main/sandbox/docker"
import { friendlyError } from "../src/main/orchestrator/errors"
import { fallbackModels, usageOf } from "../src/main/orchestrator/model"
import { TaskRunner } from "../src/main/orchestrator/runner"
import { FilesystemBackend } from "deepagents"

/*
  specs/orchestrator: whole tasks against a scripted OpenRouter and the fake Claude Code CLI standing
  in for the sandbox container — decomposition, delegation, patch approval, consolidation — with the
  event log and the sandbox audit checked at the end.
*/

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs")

type Body = {
  model: string
  models?: string[]
  provider?: { data_collection?: string }
  reasoning?: { effort?: string }
  messages: { role: string; content: unknown; tool_call_id?: string }[]
  tools?: { function: { name: string } }[]
}
type Reply = { content?: string; tool_calls?: { name: string; args: unknown }[] } | ((body: Body) => Reply)

let script: Reply[] = []
let requests: Body[] = []
let status = 200
const realFetch = globalThis.fetch

function lastTool(body: Body): string {
  const m = [...body.messages].reverse().find((x) => x.role === "tool")
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")
}

beforeAll(() => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body
    requests.push(body)
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "Insufficient credits", code: status } }), { status })
    let next = script.shift()
    if (!next) throw new Error("The script ran out of replies")
    if (typeof next === "function") next = next(body)
    const r = next as Exclude<Reply, (b: Body) => Reply>
    let n = 0
    const message = {
      role: "assistant",
      content: r.content ?? null,
      tool_calls: r.tool_calls?.map((t) => ({
        id: `call_${requests.length}_${n++}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      })),
    }
    return new Response(
      JSON.stringify({
        id: `gen-${requests.length}`,
        model: body.model,
        choices: [{ message, finish_reason: r.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
      }),
    )
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

let base = ""
let root = ""
let data = ""
let fakeLog = ""
let log: EventLog
let settings: Settings
let fakeMode = "answer"
let refusal: string | null = null

function launcher(): Launcher {
  return {
    preflight: async () => refusal,
    launch: (ws, mode) => ({
      command: process.execPath,
      args: [FAKE, ...claudeArgs(mode).slice(1)],
      cwd: ws.workspace,
      env: { HFR_FAKE: fakeMode, HFR_FAKE_LOG: fakeLog, HFR_RUN: ws.runDir, PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    }),
  }
}

function runner(key: string | null = "sk-or-v1-testkey000000") {
  return new TaskRunner({
    log,
    dataDir: data,
    launcher: launcher(),
    settings: () => settings,
    apiKey: () => key,
    workspace: async () => {
      await workspaceGate
      if (workspaceFails) throw new Error(workspaceFails)
      return { backend: new FilesystemBackend({ rootDir: root, virtualMode: true }), root: "/", dispose: async () => void disposed++ }
    },
  })
}

let disposed = 0
let workspaceFails = ""
let workspaceGate: Promise<void> = Promise.resolve()

const REQUEST = "The parser in src/a.ts drops the last token; find out why and fix it. Codeword: PINEAPPLE-42."

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-orch-"))
  root = join(base, "repo")
  data = join(base, "data")
  fakeLog = join(base, "fake.jsonl")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const parse = (s) => s.split(' ').slice(0, -1)\n")
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2\n")
  openDb(join(data, "hfr.db"))
  log = new EventLog(data)
  settings = { ...DEFAULT_SETTINGS, timeoutMinutes: 1 }
  script = []
  requests = []
  status = 200
  fakeMode = "answer"
  disposed = 0
  workspaceFails = ""
  workspaceGate = Promise.resolve()
  refusal = null
})
afterEach(() => closeDb())

const kinds = (taskId: string) => log.history(taskId).events.map((e) => e.kind)

const todos = {
  name: "write_todos",
  args: {
    todos: [
      { content: "Find the bug in the parser", status: "in_progress" },
      { content: "Fix it", status: "pending" },
    ],
  },
}
const delegateModify = {
  name: "delegate_to_specialist",
  args: {
    brief: "The user maintains a small CLI parser in their own repository; a bug report says the last argument is lost.",
    objective: "Find why parse drops the last token and fix it",
    mode: "modify",
    files: ["/src/a.ts"],
    questions: ["Which expression drops it?"],
    constraints: ["Keep the signature"],
  },
}
const applyFromLast = (body: Body): Reply => ({ tool_calls: [{ name: "apply_patch", args: { patchId: JSON.parse(lastTool(body)).patch.patchId } }] })

describe("end to end (specs/orchestrator 3.2)", () => {
  it("decomposes, delegates, waits for approval, applies the patch and consolidates", async () => {
    script = [
      { tool_calls: [todos] },
      { tool_calls: [{ name: "read_file", args: { file_path: "/src/a.ts" } }] },
      { tool_calls: [{ name: "write_file", args: { file_path: "/evil.txt", content: "x" } }] },
      { tool_calls: [delegateModify] },
      applyFromLast,
      (body) => ({ content: `Done. ${lastTool(body)} Evidence: src/a.ts:1-1` }),
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)

    expect(log.getTask(task.id).state).toBe("waiting")
    const [patch] = log.history(task.id).patches
    expect(patch.state).toBe("proposed")
    expect(patch.diff).toContain("+export const parse = (s) => s.split(' ').slice(0, -1) // fixed")
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).not.toContain("// fixed")

    r.decide(task.id, patch.id, "approve")
    await r.settled(task.id)

    const done = log.getTask(task.id)
    expect(done.state).toBe("done")
    expect(done.result).toContain("Applied the approved patch to src/a.ts")
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("// fixed")
    expect(existsSync(join(root, "evil.txt"))).toBe(false)

    // the event log
    const k = kinds(task.id)
    for (const want of [
      "task.started",
      "todos",
      "model.call",
      "sandbox.copy",
      "specialist.init",
      "specialist.tool.call",
      "specialist.result",
      "patch.proposed",
      "approval.requested",
      "approval.decided",
      "approval.resumed",
      "patch.approved",
      "patch.applied",
      "sandbox.discarded",
      "task.done",
    ])
      expect(k, want).toContain(want)
    expect(k.indexOf("approval.requested")).toBeLessThan(k.indexOf("patch.applied"))

    // the sandbox audit: copied, read and written by the specialist, applied
    const files = log.history(task.id).events.flatMap((e) => (e.payload.files ?? []).map((f) => `${f.op}:${f.path}`))
    expect(files).toEqual(expect.arrayContaining(["copy:src/a.ts", "read:src/a.ts", "write:src/a.ts", "apply:src/a.ts"]))
    expect(files).not.toContain("copy:src/b.ts")

    // steps, usage and cost
    const steps = log.steps(task.id)
    expect(steps.filter((s) => s.kind === "todo").map((s) => s.title)).toEqual(["Find the bug in the parser", "Fix it"])
    const delegation = steps.find((s) => s.kind === "delegation")!
    expect(delegation.state).toBe("done")
    expect(delegation.data.evidence).toEqual([expect.objectContaining({ path: "src/a.ts", startLine: 1, checked: true })])
    expect(done.tokensIn).toBeGreaterThan(600)
    expect(done.costUsd).toBeCloseTo(0.006, 5)
    expect(done.specialistCostUsd).toBeCloseTo(0.42, 5)

    // OpenRouter got the fallback and data collection denied
    expect(requests[0].models).toEqual(fallbackModels(settings.model))
    expect(requests[0].provider?.data_collection).toBe("deny")
    expect(requests[0]).not.toHaveProperty("reasoning")
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(["write_todos", "delegate_to_specialist", "apply_patch", "read_file"]),
    )

    // the specialist saw only its package: no request, no host path
    const fake = readFileSync(fakeLog, "utf8")
    expect(fake).not.toContain("PINEAPPLE")
    expect(fake).toContain("/work/src/a.ts")
    expect(fake).not.toContain(root.replace(/\\/g, "\\\\"))
    expect(readFileSync(join(data, "tasks", task.id, "raw.jsonl"), "utf8")).toContain("specialist")
    expect(existsSync(join(data, "workspace"))).toBe(true)
  })

  it("records a rejection, leaves the files alone and carries on", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast, { content: "The user rejected the fix." }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    const [patch] = log.history(task.id).patches
    expect(r.decide(task.id, patch.id, "reject").id).toBe(patch.id)
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "done", result: "The user rejected the fix." })
    expect(log.getPatch(patch.id).state).toBe("rejected")
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).not.toContain("// fixed")
    expect(kinds(task.id)).toContain("patch.rejected")
    expect(() => r.decide(task.id, patch.id, "approve")).toThrow(/not waiting/)
  })

  it("returns a refused delegation and an invalid package to the agent as tool errors", async () => {
    refusal = "Docker is unavailable (pipe not found)."
    script = [
      { tool_calls: [delegateModify] },
      (body) => {
        expect(lastTool(body)).toContain("Docker is unavailable")
        refusal = null
        return { tool_calls: [{ name: "delegate_to_specialist", args: { brief: "b", objective: "x", files: ["../outside.txt"] } }] }
      },
      (body) => {
        expect(lastTool(body)).toMatch(/ERROR: \.\.\/outside\.txt cannot be delegated/)
        return { tool_calls: [{ name: "delegate_to_specialist", args: { brief: "b", objective: "x", files: [] } }] }
      },
      (body) => {
        expect(lastTool(body).toLowerCase()).toContain("error")
        return { tool_calls: [{ name: "apply_patch", args: { patchId: "00000000-0000-4000-8000-000000000009" } }] }
      },
      { content: "Could not delegate." },
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "done", result: "Could not delegate." })
    const k = kinds(task.id)
    expect(k.filter((x) => x === "sandbox.refused")).toHaveLength(2)
    expect(log.history(task.id).events.find((e) => e.payload.rejectedPath)?.payload.rejectedPath).toBe("../outside.txt")
  })

  it("cancels a running task, stopping the delegation", async () => {
    fakeMode = "hang"
    script = [{ tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    for (let i = 0; i < 100 && !kinds(task.id).includes("specialist.init"); i++) await new Promise((res) => setTimeout(res, 50))
    r.cancel(task.id)
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("cancelled")
    expect(log.steps(task.id).find((s) => s.kind === "delegation")?.state).toBe("cancelled")
    expect(() => r.cancel(task.id)).toThrow(/not running/)
  })

  it("cancels a task waiting for approval and rejects its patch", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    const [patch] = log.history(task.id).patches
    expect(r.isLive(task.id)).toBe(true)
    expect(r.cancel(task.id).state).toBe("cancelled")
    expect(r.isLive(task.id)).toBe(false)
    expect(log.getPatch(patch.id).state).toBe("rejected")
    expect(log.steps(task.id).filter((s) => s.state === "running" || s.state === "pending")).toEqual([])
  })

  it("fails with an actionable message when OpenRouter refuses, and retries from the same request", async () => {
    status = 402
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("out of credits") })
    status = 200
    script = [{ content: "Second time lucky." }]
    const again = r.retry(task.id)
    expect(again.id).not.toBe(task.id)
    expect(again.request).toBe(log.getTask(task.id).request)
    await r.settled(again.id)
    expect(log.getTask(again.id).result).toBe("Second time lucky.")
    expect(() => r.retry(again.id)).toThrow(/Only an interrupted/)
  })

  it("gives the agent no way to write, delete, execute or read outside the source folder (R2.2)", async () => {
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET-VALUE")
    const results: string[] = []
    const call =
      (name: string, args: unknown): Reply =>
      (body) => {
        if (requests.length > 1) results.push(lastTool(body))
        return { tool_calls: [{ name, args }] }
      }
    script = [
      call("execute", { command: "echo pwned > pwned.txt" }),
      call("edit_file", { file_path: "/src/b.ts", old_string: "2", new_string: "3" }),
      call("delete", { file_path: "/src/b.ts" }),
      call("read_file", { file_path: "/../secret.txt" }),
      call("ls", { path: "/.." }),
      (body) => {
        results.push(lastTool(body))
        return { content: "done" }
      },
    ]
    const r = runner()
    const task = r.start({ request: "probe", sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("done")
    expect(results).toHaveLength(5)
    expect(existsSync(join(root, "pwned.txt"))).toBe(false)
    expect(existsSync(join(data, "pwned.txt"))).toBe(false)
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 2\n")
    for (const out of results) expect(out).not.toContain("TOP-SECRET-VALUE")
  })

  it("hands the orchestrator's brief to the specialist first, with host paths scrubbed", async () => {
    script = [
      () => ({
        tool_calls: [
          {
            name: "delegate_to_specialist",
            args: { ...delegateModify.args, mode: "read", brief: `The user owns the parser at ${root}\\src\\a.ts and is debugging it.` },
          },
        ],
      }),
      { content: "ok" },
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    const turn = readFileSync(fakeLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.turn)
    expect(turn.prompt.startsWith("## Brief\nThe user owns the parser at /work/src/a.ts and is debugging it.")).toBe(true)
    expect(turn.prompt.toLowerCase()).not.toContain(root.toLowerCase())
  })

  it("redacts secret shapes from the report before it reaches OpenRouter", async () => {
    fakeMode = "leak"
    script = [{ tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("done")
    expect(JSON.stringify(requests)).not.toContain("LEAKEDTOKEN")
    expect(JSON.stringify(requests)).toContain("[redacted]")
  })

  it("counts what a failed delegation spent", async () => {
    fakeMode = "limit"
    script = [{ tool_calls: [delegateModify] }, (body) => ({ content: lastTool(body) })]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    const done = log.getTask(task.id)
    expect(done.result).toMatch(/ERROR: .*limit is reached/)
    expect(done.specialistCostUsd).toBeCloseTo(0.01, 5)
    expect(log.steps(task.id).find((s) => s.kind === "delegation")?.state).toBe("failed")
  })

  it("refuses to start without a folder or a key", () => {
    expect(() => runner().start({ request: "x", sourceRoot: join(root, "nope") })).toThrow(/not a folder/)
    expect(() => runner(null).start({ request: "x", sourceRoot: root })).toThrow(/API key/)
  })
})

describe("the task's workspace is removed when the task ends (R2.2)", () => {
  const settle = async (r: TaskRunner, id: string) => {
    await r.settled(id)
    await new Promise((res) => setTimeout(res, 10))
  }

  it("on done and on failure", async () => {
    script = [{ content: "done" }]
    const r = runner()
    const done = r.start({ request: "x", sourceRoot: root })
    await settle(r, done.id)
    expect(disposed).toBe(1)
    status = 402
    const failed = r.start({ request: "y", sourceRoot: root })
    await settle(r, failed.id)
    expect(log.getTask(failed.id).state).toBe("failed")
    expect(disposed).toBe(2)
  })

  it("on cancel while waiting, and not before: a paused task keeps it", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await settle(r, task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    expect(disposed).toBe(0)
    r.cancel(task.id)
    await settle(r, task.id)
    expect(disposed).toBe(1)
  })

  it("on cancel while the workspace is still starting, once it is up", async () => {
    let open: () => void = () => undefined
    workspaceGate = new Promise((res) => (open = res))
    const r = runner()
    const task = r.start({ request: "x", sourceRoot: root })
    r.cancel(task.id)
    expect(disposed).toBe(0)
    open()
    await settle(r, task.id)
    expect(log.getTask(task.id).state).toBe("cancelled")
    expect(disposed).toBe(1)
  })

  it("fails the task with Docker's reason when the workspace cannot start", async () => {
    workspaceFails = "Docker is unavailable (pipe not found)."
    const r = runner()
    const task = r.start({ request: "x", sourceRoot: root })
    await settle(r, task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "failed", error: "Docker is unavailable (pipe not found)." })
  })

  it("on quit: stopAll resolves only after every workspace is down", async () => {
    fakeMode = "hang"
    script = [{ tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    for (let i = 0; i < 100 && !kinds(task.id).includes("specialist.init"); i++) await new Promise((res) => setTimeout(res, 50))
    await r.stopAll()
    expect(disposed).toBe(1)
    await r.settled(task.id)
  })
})

describe("model and errors (R1.1–R1.4)", () => {
  it("falls back to the preset unless it is the chosen model", () => {
    expect(fallbackModels("a/b")).toEqual(["a/b", PRESET_MODEL])
    expect(fallbackModels(PRESET_MODEL)).toEqual([PRESET_MODEL])
  })

  it("reads usage, cost and the answering model", () => {
    expect(
      usageOf(
        {
          llmOutput: { tokenUsage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.1 } },
          generations: [[{ message: { response_metadata: { model_name: "z" } } }]],
        },
        "m",
      ),
    ).toEqual({
      tokensIn: 5,
      tokensOut: 2,
      costUsd: 0.1,
      model: "z",
    })
    expect(usageOf({ generations: [[{ message: { usage_metadata: { input_tokens: 1, output_tokens: 1 } } }]] }, "m")).toEqual({
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: "m",
    })
  })

  it("maps OpenRouter failures to actionable messages", () => {
    expect(friendlyError({ status: 401 }).message).toMatch(/rejected the API key/)
    expect(friendlyError({ statusCode: 402 }).message).toMatch(/out of credits/)
    expect(friendlyError({ status: 429 }).message).toMatch(/rate-limiting/)
    expect(friendlyError(new Error("No endpoints found that support tool use")).message).toMatch(/No OpenRouter provider/)
    expect(friendlyError({ name: "AbortError", message: "x" }).message).toBe("Cancelled.")
    const plain = new Error("other")
    expect(friendlyError(plain)).toBe(plain)
    expect(friendlyError("text").message).toBe("text")
  })

  it("builds the production launcher on docker only", () => {
    const l = dockerLauncher(async () => ({ code: 0, stdout: "", stderr: "" }))
    const launch = l.launch({ id: "i", workspace: "w", runDir: "r", snapshot: "s", files: [] }, "read", { memoryMb: 1, cpus: 1, pidsLimit: 32 })
    expect(launch.command).toBe("docker")
    expect(launch.args[0]).toBe("run")
    expect(launch.args).toContain("claude")
    const high = l.launch({ id: "i", workspace: "w", runDir: "r", snapshot: "s", files: [] }, "read", {
      memoryMb: 1,
      cpus: 1,
      pidsLimit: 32,
      specialistEffort: "high",
    })
    expect(high.args.slice(high.args.indexOf("--effort"), high.args.indexOf("--effort") + 2)).toEqual(["--effort", "high"])
  })

  it("sends the chosen reasoning effort to OpenRouter (R1.5)", async () => {
    settings = { ...settings, orchestratorEffort: "high" }
    script = [{ content: "ok" }]
    const r = runner()
    const task = r.start({ request: "x", sourceRoot: root })
    await r.settled(task.id)
    expect(requests[0].reasoning).toEqual({ effort: "high" })
  })
})
