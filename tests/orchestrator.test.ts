import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { QUESTION_CAP } from "../src/shared/chat"
import { DEFAULT_SETTINGS, PRESET_MODEL } from "../src/shared/defaults"
import type { Settings } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { EventLog } from "../src/main/events/log"
import { dockerLauncher, type Launcher } from "../src/main/delegation"
import { claudeArgs } from "../src/main/sandbox/docker"
import { friendlyError } from "../src/main/orchestrator/errors"
import { fallbackModels, usageOf } from "../src/main/orchestrator/model"
import { systemPrompt } from "../src/main/orchestrator/agent"
import { TaskRunner } from "../src/main/orchestrator/runner"
import { SCRATCH, TaskBox, WORKSPACE } from "../src/main/sandbox/taskbox"
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
type Reply = { content?: string; tool_calls?: { name: string; args: unknown }[] } | ((body: Body) => Reply | Promise<Reply>)

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
    if (typeof next === "function") next = await next(body)
    const r = next as Exclude<Reply, (b: Body) => unknown>
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
let fakeQuestion = ""
let refusal: string | null = null

function launcher(): Launcher {
  return {
    preflight: async () => refusal,
    launch: (ws, mode) => ({
      command: process.execPath,
      args: [FAKE, ...claudeArgs(mode).slice(1)],
      cwd: ws.workspace,
      env: {
        HFR_FAKE: fakeMode,
        HFR_FAKE_LOG: fakeLog,
        HFR_RUN: ws.runDir,
        HFR_FAKE_QUESTION: fakeQuestion,
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      },
    }),
  }
}

function runner(key: string | null = "sk-or-v1-testkey000000") {
  return new TaskRunner({
    stopGraceMs: 50,
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
  fakeQuestion = JSON.stringify({ prompt: "Is the input UTF-8?", reason: "It decides the tokenizer.", kind: "yesno", default: false })
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
    expect(done.state).toBe("awaiting-user")
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
      "turn.done",
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
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "The user rejected the fix." })
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
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Could not delegate." })
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
    const task = r.start({ request: REQUEST, sourceRoot: root, gated: ["execute"] })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("out of credits") })
    status = 200
    script = [{ content: "Second time lucky." }]
    const gatedOf = (id: string) => log.history(id).events.find((e) => e.kind === "task.started")!.payload.gated
    expect(gatedOf(task.id)).toEqual(["apply_patch", "execute"])
    const again = r.retry(task.id)
    expect(gatedOf(again.id)).toEqual(gatedOf(task.id))
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
    expect(log.getTask(task.id).state).toBe("awaiting-user")
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
    expect(log.getTask(task.id).state).toBe("awaiting-user")
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

  it("runs a long exploration of many tool calls to its answer", async () => {
    script = [...Array.from({ length: 120 }, () => ({ tool_calls: [{ name: "read_file", args: { file_path: "/src/b.ts" } }] })), { content: "read it all" }]
    const r = runner()
    const task = r.start({ request: "x", sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "read it all" })
  }, 60_000)
})

describe("the agent on the task container's backend (R2.2)", () => {
  it("builds and runs with a backend that executes commands, which takes no path rules", async () => {
    const calls: string[][] = []
    const exec = async (args: string[]) => {
      calls.push(args)
      return { code: 0, stdout: Buffer.from("README.md\n"), stderr: "" }
    }
    const r = new TaskRunner({
      log,
      dataDir: data,
      launcher: launcher(),
      settings: () => settings,
      apiKey: () => "sk-or-v1-testkey000000",
      workspace: async (task) => ({ backend: new TaskBox(exec, task.id), root: WORKSPACE, dispose: async () => undefined }),
    })
    script = [{ tool_calls: [{ name: "execute", args: { command: "ls /workspace" } }] }, (body) => ({ content: `saw ${lastTool(body)}` })]
    const task = r.start({ request: "x", sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", error: "" })
    expect(log.getTask(task.id).result).toContain("README.md")
    expect(calls.some((c) => c[0] === "exec" && c.includes("ls /workspace"))).toBe(true)
  })
})

describe("the task's workspace is removed when the task ends (R2.2)", () => {
  const settle = async (r: TaskRunner, id: string) => {
    await r.settled(id)
    await new Promise((res) => setTimeout(res, 10))
  }

  it("on close and on failure, and not at the end of a turn", async () => {
    script = [{ content: "done" }]
    const r = runner()
    const done = r.start({ request: "x", sourceRoot: root })
    await settle(r, done.id)
    expect(disposed).toBe(0)
    r.close(done.id)
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

describe("the conversation (specs/chat R1)", () => {
  const userTexts = (body: Body) =>
    body.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))

  it("leaves a finished turn awaiting the user and continues the same thread from the next message", async () => {
    script = [
      { content: "First answer." },
      (body) => {
        expect(userTexts(body)).toEqual([REQUEST, "And what about b.ts?"])
        expect(body.messages.some((m) => m.role === "assistant" && m.content === "First answer.")).toBe(true)
        return { content: "Second answer." }
      },
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "First answer." })
    expect(r.isLive(task.id)).toBe(true)
    expect(disposed).toBe(0)

    expect(r.sendMessage(task.id, "And what about b.ts?").state).toBe("running")
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Second answer." })
    expect(requests).toHaveLength(2)
    expect(disposed).toBe(0)

    expect(r.close(task.id).state).toBe("done")
    await new Promise((res) => setTimeout(res, 10))
    expect(r.isLive(task.id)).toBe(false)
    expect(disposed).toBe(1)
    expect(() => r.sendMessage(task.id, "more")).toThrow(/closed/)
  })

  it("records each user and agent message in order with the task's other events (R1.3)", async () => {
    script = [{ content: "Looking.", tool_calls: [{ name: "ls", args: { path: "/src" } }] }, { content: "First answer." }, { content: "Second answer." }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    r.sendMessage(task.id, "Thanks, and b.ts?")
    await r.settled(task.id)
    const said = log
      .history(task.id)
      .events.filter((e) => e.kind.startsWith("message.") || e.kind === "tool.call")
      .map((e) => `${e.kind}:${e.kind === "tool.call" ? e.summary : e.payload.output}`)
    expect(said).toEqual([
      `message.user:${REQUEST}`,
      "message.agent:Looking.",
      "tool.call:ls",
      "message.agent:First answer.",
      "message.user:Thanks, and b.ts?",
      "message.read:Thanks, and b.ts?",
      "message.agent:Second answer.",
    ])
  })

  it("derives where the conversation stands from the checkpointer (R1.5)", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast, { content: "Applied." }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    expect(await r.turn(task.id)).toBe("running")
    await r.settled(task.id)
    expect(await r.turn(task.id)).toBe("waiting")
    r.decide(task.id, log.history(task.id).patches[0].id, "approve")
    await r.settled(task.id)
    expect(await r.turn(task.id)).toBe("awaiting-user")
    r.close(task.id)
    expect(await r.turn(task.id)).toBeUndefined()
  })
})

describe("messages sent mid-turn (specs/chat R2)", () => {
  it("delivers the message before the next model call, records it read, and keeps it from the delegation", async () => {
    let r!: TaskRunner
    let taskId = ""
    const NOTE = "Mid-turn: focus on the split call. Codeword MANGO-7."
    script = [
      () => {
        expect(r.sendMessage(taskId, NOTE).state).toBe("running")
        return { tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }
      },
      (body) => {
        const users = body.messages.filter((m) => m.role === "user").map((m) => m.content)
        expect(users.at(-1)).toBe(NOTE)
        // after the tool result it answered, never between a call and its result
        expect(body.messages.at(-1)?.role).toBe("user")
        expect(body.messages.at(-2)?.role).toBe("tool")
        return { content: "Focused." }
      },
    ]
    r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    taskId = task.id
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Focused." })
    const k = kinds(task.id)
    expect(k.indexOf("message.read")).toBeGreaterThan(k.lastIndexOf("message.user"))
    expect(log.history(task.id).events.find((e) => e.kind === "message.read")?.payload.output).toBe(NOTE)
    expect(readFileSync(fakeLog, "utf8")).not.toContain("MANGO-7")
  })

  it("does not strand a message sent during the turn's last model call", async () => {
    let r!: TaskRunner
    let taskId = ""
    script = [
      () => {
        r.sendMessage(taskId, "One more thing.")
        return { content: "First." }
      },
      (body) => {
        expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "One more thing." })
        return { content: "Second." }
      },
    ]
    r = runner()
    taskId = r.start({ request: REQUEST, sourceRoot: root }).id
    await r.settled(taskId)
    expect(log.getTask(taskId)).toMatchObject({ state: "awaiting-user", result: "Second." })
  })
})

describe("stop and continue (specs/chat R3)", () => {
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((res) => setTimeout(res, 50))
  }

  it("stops a turn without ending the task, aborting the delegation, and continues it from the checkpoint", async () => {
    fakeMode = "hang"
    script = [{ tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await until(() => kinds(task.id).includes("specialist.init"))
    expect(r.stopTurn(task.id).state).toBe("stopped")
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("stopped")
    expect(kinds(task.id)).toContain("turn.stopped")
    expect(log.steps(task.id).find((s) => s.kind === "delegation")?.state).toBe("cancelled")
    expect(r.isLive(task.id)).toBe(true)
    expect(disposed).toBe(0)
    expect(await r.turn(task.id)).toBe("stopped")

    fakeMode = "answer"
    script = [{ content: "Resumed." }]
    expect(r.continueTurn(task.id).state).toBe("running")
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Resumed." })
    // the interrupted delegation ran again from the checkpoint; the first model call did not
    expect(requests).toHaveLength(2)
    expect(
      log
        .steps(task.id)
        .filter((s) => s.kind === "delegation")
        .map((s) => s.state),
    ).toEqual(["cancelled", "done"])
    expect(() => r.continueTurn(task.id)).toThrow(/not stopped/)
  })

  it("marks the turn stopped even when the stream never observes the stop, and ignores what it says later", async () => {
    let release: () => void = () => undefined
    const hung = new Promise<void>((res) => (release = res))
    script = [
      async () => {
        await hung
        return { content: "Stale." }
      },
      { content: "Back." },
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await until(() => requests.length === 1)
    expect(r.stopTurn(task.id).state).toBe("stopped")
    expect(log.getTask(task.id).state).toBe("stopped")
    r.continueTurn(task.id)
    await until(() => log.getTask(task.id).state === "awaiting-user")
    expect(log.getTask(task.id).result).toBe("Back.")
    release()
    await new Promise((res) => setTimeout(res, 50))
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Back." })
    expect(kinds(task.id).filter((k) => k === "turn.done")).toHaveLength(1)
  })

  it("rejects the pending gated calls of a turn stopped while waiting, and resumes with them on continue", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast, (body) => ({ content: `After stop: ${lastTool(body)}` })]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    r.stopTurn(task.id)
    expect(log.getTask(task.id).state).toBe("stopped")
    // the chat folds the log, so the stop's rejection is recorded and no card stays actionable (R7.3, R7.5)
    const decided = log.history(task.id).events.filter((e) => e.kind === "approval.decided")
    expect(decided).toEqual([expect.objectContaining({ payload: expect.objectContaining({ tool: "apply_patch", origin: "stopped" }) })])
    r.sendMessage(task.id, "Leave it for now.")
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    // a rejection jumps straight to the model, so the message rides on it rather than waiting a turn
    expect(log.getTask(task.id).result).toContain("stopped")
    expect(log.getTask(task.id).result).toContain("Leave it for now.")
    expect(requests).toHaveLength(3)
    expect(log.history(task.id).patches[0].state).toBe("rejected")
  })
})

describe("approving tool calls (specs/chat R4)", () => {
  const pendingCalls = (taskId: string) => {
    const ev = log
      .history(taskId)
      .events.filter((e) => e.kind === "approval.requested")
      .at(-1)
    return (ev?.payload.calls ?? []) as { callId: string; name: string; args: Record<string, unknown> }[]
  }

  it("pauses the chosen tools, runs an edited call with the new arguments, and returns a rejection's message", async () => {
    const read = { ...delegateModify, args: { ...delegateModify.args, mode: "read" } }
    script = [
      { tool_calls: [read] },
      (body) => {
        expect(lastTool(body)).toContain("report")
        return { tool_calls: [read] }
      },
      (body) => ({ content: `Agent saw: ${lastTool(body)}` }),
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root, gated: ["delegate_to_specialist"] })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    const [first] = pendingCalls(task.id)
    expect(first).toMatchObject({ name: "delegate_to_specialist", args: { objective: delegateModify.args.objective } })
    expect(kinds(task.id)).not.toContain("sandbox.copy")

    r.decideTool(task.id, first.callId, { type: "edit", args: { ...read.args, objective: "EDITED-OBJECTIVE" } })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    expect(readFileSync(fakeLog, "utf8")).toContain("EDITED-OBJECTIVE")

    const [second] = pendingCalls(task.id)
    expect(second.callId).not.toBe(first.callId)
    r.decideTool(task.id, second.callId, { type: "reject", message: "Not that one again." })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "Agent saw: Not that one again." })
    expect(kinds(task.id).filter((k) => k === "sandbox.copy")).toHaveLength(1)
    const decided = log
      .history(task.id)
      .events.filter((e) => e.kind === "approval.decided")
      .map((e) => e.payload.decision)
    expect(decided).toEqual([expect.objectContaining({ type: "edit" }), { type: "reject", message: "Not that one again." }])
    expect(() => r.decideTool(task.id, second.callId, { type: "approve" })).toThrow(/not waiting/)
  })

  it("always gates apply_patch, which takes approve or reject but no edit", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root, gated: [] })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    const [call] = pendingCalls(task.id)
    expect(call.name).toBe("apply_patch")
    expect(r.waitsOn(task.id, String(call.args.patchId))).toBe(true)
    expect(r.waitsOn(task.id, "00000000-0000-4000-8000-000000000009")).toBe(false)
    expect(() => r.decideTool(task.id, call.callId, { type: "edit", args: { patchId: call.args.patchId } })).toThrow(/cannot be edited/)
    r.decideTool(task.id, call.callId, { type: "approve" })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("// fixed")
  })

  it("runs every call without asking, apply_patch included, when the task was started so (R4.6)", async () => {
    script = [{ tool_calls: [delegateModify] }, applyFromLast, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root, gated: ["delegate_to_specialist"], auto: true })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    expect(pendingCalls(task.id)).toEqual([])
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("// fixed")
    expect(log.history(task.id).events.find((e) => e.kind === "task.started")!.payload).toMatchObject({ gated: [], auto: true })
  })

  it("keeps the choice to run every call without asking when the task is retried (R4.6)", async () => {
    status = 402
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root, auto: true })
    await r.settled(task.id)
    status = 200
    script = [{ content: "again" }]
    const again = r.retry(task.id)
    expect(log.history(again.id).events.find((e) => e.kind === "task.started")!.payload).toMatchObject({ gated: [], auto: true })
    await r.settled(again.id)
  })

  it("rejects a gated call that waits past the approval timeout, recording the timeout as its origin (R4.5)", async () => {
    settings = { ...settings, approvalTimeoutMinutes: 0.001 }
    script = [{ tool_calls: [delegateModify] }, applyFromLast, (body) => ({ content: `Timed out: ${lastTool(body)}` })]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("waiting")
    const [patch] = log.history(task.id).patches
    for (let i = 0; i < 40 && log.getTask(task.id).state !== "awaiting-user"; i++) await new Promise((res) => setTimeout(res, 25))
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    expect(log.getTask(task.id).result).toMatch(/Timed out: .*approval timeout/)
    expect(log.getPatch(patch.id).state).toBe("rejected")
    expect(log.history(task.id).events.find((e) => e.kind === "approval.decided")?.payload).toMatchObject({ origin: "timeout", decision: { type: "reject" } })
    expect(() => r.decide(task.id, patch.id, "approve")).toThrow(/not waiting/)
  })

  it("does not time out a call the user decided in time", async () => {
    settings = { ...settings, approvalTimeoutMinutes: 0.002 }
    script = [{ tool_calls: [delegateModify] }, applyFromLast, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    r.decide(task.id, log.history(task.id).patches[0].id, "approve")
    await r.settled(task.id)
    await new Promise((res) => setTimeout(res, 200))
    expect(
      log
        .history(task.id)
        .events.filter((e) => e.kind === "approval.decided")
        .map((e) => e.payload.origin),
    ).toEqual(["user"])
  })
})

describe("the orchestrator asks the user (specs/chat R5.1, R5.4, R5.5)", () => {
  const ask = (o: Record<string, unknown> = {}) => ({
    name: "ask_user",
    args: {
      prompt: "Which build is deployed?",
      reason: "The two builds parse differently.",
      kind: "choice",
      choices: ["debug", "release"],
      default: "debug",
      ...o,
    },
  })
  const toolResults = (body: Body) => body.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  const asked = (taskId: string) => log.history(taskId).events.filter((e) => e.kind === "question.asked")

  it("pauses the turn until the user answers, and returns the answer with its origin", async () => {
    script = [{ tool_calls: [ask()] }, (body) => ({ content: `Got ${lastTool(body)}` })]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    for (let i = 0; i < 100 && !asked(task.id).length; i++) await new Promise((res) => setTimeout(res, 20))
    const [q] = asked(task.id)
    expect(q.payload).toMatchObject({ agent: "orchestrator", question: { kind: "choice", choices: ["debug", "release"] } })
    expect(log.getTask(task.id).state).toBe("waiting")
    expect(await r.turn(task.id)).toBe("waiting")
    const qid = String(q.payload.questionId)
    expect(() => r.answerQuestion(task.id, qid, "staging")).toThrow(/does not fit/)
    expect(r.answerQuestion(task.id, qid, "release").state).toBe("running")
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    expect(JSON.parse(log.getTask(task.id).result.slice(4))).toEqual({ answer: "release", origin: "user" })
    expect(log.history(task.id).events.find((e) => e.kind === "question.answered")?.payload).toMatchObject({
      questionId: qid,
      answer: "release",
      origin: "user",
    })
    expect(() => r.answerQuestion(task.id, qid, "debug")).toThrow(/not waiting/)
  })

  it("returns the default when the question times out, and refuses a default that does not fit its kind", async () => {
    settings = { ...settings, questionTimeoutMinutes: 0.001 }
    script = [
      { tool_calls: [ask({ kind: "yesno", choices: undefined, default: "maybe" })] },
      (body) => {
        expect(lastTool(body)).toMatch(/^ERROR: .*true or false/)
        return { tool_calls: [ask({ kind: "yesno", choices: undefined, default: false })] }
      },
      (body) => ({ content: lastTool(body) }),
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(JSON.parse(log.getTask(task.id).result)).toEqual({ answer: false, origin: "timeout" })
  })

  it("caps the questions in one turn, returning the default past the cap", async () => {
    settings = { ...settings, questionTimeoutMinutes: 0.001 }
    script = [
      { tool_calls: Array.from({ length: QUESTION_CAP + 1 }, () => ask()) },
      (body) => {
        const origins = toolResults(body).map((t) => JSON.parse(t).origin)
        expect(origins.filter((o) => o === "timeout")).toHaveLength(QUESTION_CAP)
        expect(origins.filter((o) => o === "cap")).toHaveLength(1)
        return { content: "capped" }
      },
    ]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user", result: "capped" })
    expect(asked(task.id)).toHaveLength(QUESTION_CAP)
  })
})

describe("the specialist asks the user (specs/chat R5.2)", () => {
  const read = { tool_calls: [{ ...delegateModify, args: { ...delegateModify.args, mode: "read" } }] }
  const asked = (taskId: string) => log.history(taskId).events.filter((e) => e.kind === "question.asked")
  const heard = () =>
    readFileSync(fakeLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.heard)?.heard

  it("carries the question from the delegation to the chat and the user's answer back into the sandbox", async () => {
    fakeMode = "ask"
    script = [read, (body) => ({ content: lastTool(body) })]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    for (let i = 0; i < 200 && !asked(task.id).length; i++) await new Promise((res) => setTimeout(res, 20))
    const [q] = asked(task.id)
    expect(q.agent).toBe("specialist")
    expect(q.stepId).toBe(log.steps(task.id).find((s) => s.kind === "delegation")?.id)
    expect(q.payload).toMatchObject({ agent: "specialist", question: { prompt: "Is the input UTF-8?", kind: "yesno" } })
    expect(log.getTask(task.id).state).toBe("waiting")
    r.answerQuestion(task.id, String(q.payload.questionId), true)
    await r.settled(task.id)
    expect(JSON.parse(heard())).toEqual({ answer: true, origin: "user" })
    expect(log.getTask(task.id)).toMatchObject({ state: "awaiting-user" })
    expect(JSON.parse(log.getTask(task.id).result).report).toContain('The user said {"answer":true,"origin":"user"}')
  })

  it("refuses a malformed question in the sandbox, and redacts and bounds what reaches the chat", async () => {
    fakeMode = "ask"
    fakeQuestion = JSON.stringify({ prompt: "Paste the key sk-ant-oat01-LEAKEDTOKEN123456?", reason: "r", kind: "yesno", default: "maybe" })
    script = [read, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(JSON.parse(heard())).toEqual({ error: expect.stringContaining("true or false") })
    expect(asked(task.id)).toHaveLength(0)
    expect(JSON.stringify(log.history(task.id).events)).not.toContain("LEAKEDTOKEN")

    // past the file cap, inside what a Windows environment variable can carry to the fake
    fakeQuestion = JSON.stringify({ prompt: "x".repeat(20_000), reason: "r", kind: "text", default: "" })
    writeFileSync(fakeLog, "")
    script = [read, { content: "ok" }]
    const again = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(again.id)
    expect(JSON.parse(heard())).toEqual({ error: expect.stringMatching(/too large|invalid/i) })
  })

  it("answers with the default when the question times out", async () => {
    fakeMode = "ask"
    settings = { ...settings, questionTimeoutMinutes: 0.001 }
    script = [read, { content: "ok" }]
    const r = runner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)
    expect(JSON.parse(heard())).toEqual({ answer: false, origin: "timeout" })
  })
})

describe("the division of labour (specs/chat R6.1, R6.2)", () => {
  it("instructs the orchestrator to delegate every analysis and conclude nothing from its own reading", () => {
    const p = systemPrompt("/workspace")
    expect(p).toMatch(/You are a coding assistant/)
    expect(p).toMatch(/The specialist does the deep research and the reverse engineering. Every analysis of what the target does.*goes to the specialist/)
    expect(p).toMatch(/never state a conclusion about code you have only read yourself/)
    expect(p).toContain("mounted read-only at `/workspace`")
    expect(p).toMatch(/read_file and grep to read the user's code you are going to write or integrate with — not to analyse the target/)
    expect(p).toMatch(/never change the source any other way/)
    expect(p).toContain("ask_user")
    expect(p).not.toContain("`/scratch`")
    expect(p).toMatch(/Prepare the scenario/)
    expect(p).toMatch(/test vectors/)
    expect(p).toMatch(/call propose_patch .* then apply_patch/)
    expect(systemPrompt("/workspace", "/scratch")).toMatch(/Write, read and run your own code in `\/scratch`.*Nothing you run can change the source/)
  })

  it("sends those instructions on every model call", async () => {
    script = [{ content: "ok" }]
    const r = runner()
    await r.settled(r.start({ request: "x", sourceRoot: root }).id)
    expect(JSON.stringify(requests[0].messages[0].content)).toContain("never state a conclusion about code you have only read yourself")
  })
})

describe("the orchestrator's tools (specs/chat R6.5)", () => {
  const probe = (calls: [string, unknown][]) => {
    const results: string[] = []
    script = [
      ...calls.map(([name, args]): Reply => (body) => {
        if (body.messages.some((m) => m.role === "tool")) results.push(lastTool(body))
        return { tool_calls: [{ name, args }] }
      }),
      (body) => {
        results.push(lastTool(body))
        return { content: "done" }
      },
    ]
    return results
  }

  it("offers the model only planning, file names, its own code, delegation, patches and questions", async () => {
    script = [{ content: "ok" }]
    const r = runner()
    await r.settled(r.start({ request: "x", sourceRoot: root }).id)
    const names = requests[0].tools!.map((t) => t.function.name)
    expect(names).toEqual(expect.arrayContaining(["write_todos", "ls", "glob", "write_file", "edit_file", "delegate_to_specialist", "apply_patch", "ask_user"]))
    expect(names).not.toContain("task")
    expect(names).not.toContain("delete")
  })

  it("reads the user's code, and refuses any tool outside the list", async () => {
    const results = probe([
      ["read_file", { file_path: "/src/a.ts" }],
      ["task", { description: "analyse a.ts", subagent_type: "general-purpose" }],
      ["delete", { file_path: "/src/a.ts" }],
    ])
    const r = runner()
    const task = r.start({ request: "x", sourceRoot: root })
    await r.settled(task.id)
    expect(results).toHaveLength(3)
    expect(results[0]).toContain("split")
    for (const out of results.slice(1)) expect(out).toMatch(/^ERROR: \w+ is not available to the orchestrator/)
    expect(existsSync(join(root, "src", "a.ts"))).toBe(true)
  })
})

describe("the orchestrator's own patch (specs/chat R6.6)", () => {
  const scratchFiles: Record<string, string> = {
    "/scratch/out/a.ts": "export const parse = (s) => s.trim().split(' ') // rewritten\n",
    "/scratch/out/decode.ts": "export const decode = (b) => b ^ 0x5a\n",
    // text with one NUL, which a diff would show only as "binary"
    "/scratch/out/hidden.ts": "export const ok = 1\n\u0000\nrequire('child_process').exec('evil')\n",
  }
  const boxRunner = () => {
    const exec = async (args: string[]) => {
      const path = args[0] === "exec" && args.includes("cat") ? args.at(-1)! : ""
      if (path in scratchFiles) return { code: 0, stdout: Buffer.from(scratchFiles[path]), stderr: "" }
      return path ? { code: 1, stdout: Buffer.from(""), stderr: "No such file or directory" } : { code: 0, stdout: Buffer.from(""), stderr: "" }
    }
    return new TaskRunner({
      log,
      dataDir: data,
      launcher: launcher(),
      settings: () => settings,
      apiKey: () => "sk-or-v1-testkey000000",
      workspace: async (task) => ({ backend: new TaskBox(exec, task.id), root: WORKSPACE, scratch: SCRATCH, dispose: async () => undefined }),
    })
  }

  it("turns files from /scratch into a patch on the source that applies only once the user approves", async () => {
    script = [
      {
        tool_calls: [
          {
            name: "propose_patch",
            args: {
              summary: "Rewrite the parser from the specialist's report",
              files: [
                { from: "/scratch/out/a.ts", to: "src/a.ts" },
                { from: "/scratch/out/decode.ts", to: "src/decode.ts" },
              ],
            },
          },
        ],
      },
      (body) => ({ tool_calls: [{ name: "apply_patch", args: { patchId: JSON.parse(lastTool(body)).patchId } }] }),
      (body) => ({ content: `Done. ${lastTool(body)}` }),
    ]
    const r = boxRunner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)

    expect(log.getTask(task.id).state).toBe("waiting")
    const [patch] = log.history(task.id).patches
    expect(patch.state).toBe("proposed")
    expect(patch.files.map((f) => `${f.status}:${f.path}`)).toEqual(["modified:src/a.ts", "added:src/decode.ts"])
    expect(patch.diff).toContain("+export const parse = (s) => s.trim().split(' ') // rewritten")
    expect(log.steps(task.id).find((s) => s.id === patch.stepId)).toMatchObject({ kind: "patch", agent: "orchestrator" })
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).not.toContain("rewritten")
    expect(existsSync(join(root, "src", "decode.ts"))).toBe(false)

    r.decide(task.id, patch.id, "approve")
    await r.settled(task.id)
    expect(log.getTask(task.id).state).toBe("awaiting-user")
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("rewritten")
    expect(readFileSync(join(root, "src", "decode.ts"), "utf8")).toContain("0x5a")
  })

  it("hands the specialist the files it prepared in /scratch beside the source's, and keeps them out of the patch (R6.7)", async () => {
    script = [
      {
        tool_calls: [
          {
            name: "delegate_to_specialist",
            args: { ...delegateModify.args, files: ["/scratch/out/decode.ts", "/workspace/src/a.ts"], excerpts: [] },
          },
        ],
      },
      (body) => ({ content: lastTool(body) }),
    ]
    const r = boxRunner()
    const task = r.start({ request: REQUEST, sourceRoot: root })
    await r.settled(task.id)

    const copy = log.history(task.id).events.find((e) => e.kind === "sandbox.copy")!
    expect(copy.payload.files).toEqual([
      { path: "src/a.ts", op: "copy" },
      { path: ".orchestrator/out/decode.ts", op: "copy" },
    ])
    const fake = readFileSync(fakeLog, "utf8")
    expect(fake).toContain("/work/.orchestrator/out/decode.ts")
    const done = JSON.parse(log.getTask(task.id).result) as { report: string; patch: unknown }
    expect(done.report).toContain("export const decode = (b) => b ^ 0x5a")
    // the specialist edited the prepared file only: nothing of it reaches the source
    expect(done.patch).toBeNull()
    expect(log.history(task.id).patches).toEqual([])
  })

  it("refuses what the user could not review or should never get: outside /scratch or the source, guarded, binary, twice, missing", async () => {
    const results: string[] = []
    const propose =
      (...pairs: [string, string][]): Reply =>
      (body) => {
        if (body.messages.some((m) => m.role === "tool")) results.push(lastTool(body))
        return { tool_calls: [{ name: "propose_patch", args: { files: pairs.map(([from, to]) => ({ from, to })) } }] }
      }
    script = [
      propose(["/workspace/src/b.ts", "src/a.ts"]),
      propose(["/scratch/out/a.ts", "../evil.ts"]),
      propose(["/scratch/out/a.ts", ".git/hooks/pre-commit"]),
      propose(["/scratch/out/a.ts", ".GIT/hooks/pre-commit"]),
      propose(["/scratch/out/a.ts", "vendor/lib/.git/hooks/post-checkout"]),
      propose(["/scratch/out/a.ts", "GIT~1/hooks/pre-commit"]),
      propose(["/scratch/out/a.ts", ".orchestrator/x.ts"]),
      propose(["/scratch/out/hidden.ts", "src/a.ts"]),
      propose(["/scratch/out/a.ts", "src/a.ts"], ["/scratch/out/decode.ts", "SRC/A.ts"]),
      propose(["/scratch", "src/a.ts"]),
      propose(["/scratch/out/missing.ts", "src/a.ts"]),
      (body) => {
        results.push(lastTool(body))
        return { content: "done" }
      },
    ]
    const r = boxRunner()
    const task = r.start({ request: "x", sourceRoot: root })
    await r.settled(task.id)
    expect(results).toHaveLength(11)
    for (const out of results) expect(out).toMatch(/^ERROR: /)
    expect(results[7]).toMatch(/binary/)
    expect(results[8]).toMatch(/named twice/)
    expect(log.history(task.id).patches).toEqual([])
    expect(existsSync(join(base, "evil.ts"))).toBe(false)
  })
})
