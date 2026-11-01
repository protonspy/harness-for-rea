// The spike behind the TUI's runtime (plans/finish-the-harness 1.7), run under Bun by tests/bun-core.test.ts: one task
// with one delegation, on the real core — node:sqlite, the event log, DeepAgents and LangGraph — against a scripted
// OpenRouter and the fake Claude Code. Prints one JSON line with what happened.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FilesystemBackend } from "deepagents"
import { DEFAULT_SETTINGS } from "../../src/shared/defaults"
import { openDb } from "../../src/main/db"
import { claudeArgs } from "../../src/main/sandbox/docker"
import { EventLog } from "../../src/main/events/log"
import { TaskRunner } from "../../src/main/orchestrator/runner"

const FAKE = join(import.meta.dirname, "fake-claude.mjs")
const data = mkdtempSync(join(tmpdir(), "hfr-bun-"))
const root = join(data, "src-root")
mkdirSync(join(root, "src"), { recursive: true })
writeFileSync(join(root, "src", "a.ts"), "export const parse = (s) => s.split(' ').slice(0, -1)\n")
openDb(join(data, "hfr.db"))
const log = new EventLog(data, () => undefined)

type Reply = { content?: string; tool_calls?: { name: string; args: unknown }[] }
const script: Reply[] = [
  {
    tool_calls: [
      {
        name: "delegate_to_specialist",
        args: { brief: "A TypeScript CLI parser.", objective: "Map parse in /work/src/a.ts", mode: "read", files: ["/src/a.ts"] },
      },
    ],
  },
  { content: "Done." },
]
let calls = 0
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
  const r = script.shift() ?? { content: "out of script" }
  calls++
  const message = {
    role: "assistant",
    content: r.content ?? null,
    tool_calls: r.tool_calls?.map((t, n) => ({ id: `call_${calls}_${n}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })),
  }
  return new Response(
    JSON.stringify({
      id: `gen-${calls}`,
      model: body.model,
      choices: [{ message, finish_reason: r.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}) as typeof fetch

const runner = new TaskRunner({
  stopGraceMs: 50,
  log,
  dataDir: data,
  launcher: {
    preflight: async () => null,
    launch: (ws, mode) => ({
      command: process.execPath,
      args: [FAKE, ...claudeArgs(mode).slice(1)],
      cwd: ws.workspace,
      env: { HFR_FAKE: "answer", HFR_RUN: ws.runDir, PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    }),
  },
  settings: () => ({ ...DEFAULT_SETTINGS, provider: "openrouter", model: "deepseek/deepseek-v4" }),
  apiKey: () => "sk-or-v1-testkey000000",
  workspace: async () => ({ backend: new FilesystemBackend({ rootDir: root, virtualMode: true }), root: "/", dispose: async () => undefined }),
})

const task = runner.start({ request: "Why does parse drop the last token?", sourceRoot: root })
await runner.settled(task.id)
const history = log.history(task.id)
console.log(
  JSON.stringify({
    runtime: `bun ${(process.versions as Record<string, string | undefined>).bun}`,
    state: log.getTask(task.id).state,
    kinds: [...new Set(history.events.map((e) => e.kind))],
    delegation: history.steps.find((s) => s.kind === "delegation")?.state,
  }),
)
process.exit(0)
