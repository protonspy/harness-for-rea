import { testRender } from "@opentui/react/test-utils"
import type { Api, ApiMethod } from "../../src/shared/api"
import type { EventRow, ProjectRow, Push, Readiness, Settings, StepRow, TaskHistory, TaskRow } from "../../src/shared/types"
import { DEFAULT_MODEL, DEFAULT_SETTINGS } from "../../src/shared/defaults"
import { App } from "../src/app/App"
import type { Bus, Route } from "../src/app/context"
import { DARK } from "../src/app/theme"

/*
  Screen tests' support (specs/tui-shell R4.1): the TUI's App on OpenTUI's test renderer, against a scripted API that
  records every method called and a push bus the test drives — no core, no Docker.
*/

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

export const FOLDER = process.platform === "win32" ? "C:\\samples\\app" : "/samples/app"
export const DATA = process.platform === "win32" ? "C:\\Users\\ana\\AppData\\Roaming\\Harness for REA" : "/home/ana/.config/Harness for REA"
export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

export const project = (o: Partial<ProjectRow> = {}): ProjectRow => ({
  id: UUID(1),
  name: "app",
  goal: "understand",
  targetPath: FOLDER,
  targetKind: "folder",
  sourceRoot: FOLDER,
  folder: "/p",
  ownsFolder: true,
  provider: "openrouter",
  model: "deepseek/deepseek-v4.1-flash-1017",
  orchestratorEffort: "default",
  specialistEffort: "medium",
  createdAt: 1,
  updatedAt: 1,
  ...o,
})

export const task = (o: Partial<TaskRow> = {}): TaskRow => ({
  id: UUID(10),
  projectId: UUID(1),
  request: "Map the protocol",
  sourceRoot: FOLDER,
  model: "m",
  state: "awaiting-user",
  result: "",
  error: "",
  createdAt: 1,
  updatedAt: 1,
  tokensIn: 1200,
  tokensOut: 300,
  costUsd: 0.02,
  specialistCostUsd: 0.05,
  ...o,
})

let eid = 0
export const event = (kind: string, payload: Record<string, unknown> = {}, o: Partial<EventRow> = {}): EventRow => ({
  id: ++eid,
  taskId: UUID(10),
  stepId: null,
  agent: "orchestrator",
  at: Date.now(),
  kind,
  state: "",
  summary: kind,
  payload,
  truncated: false,
  ...o,
})

export const step = (o: Partial<StepRow> = {}): StepRow => ({
  id: "s1",
  taskId: UUID(10),
  ord: 1,
  kind: "delegation",
  title: "Map the parser",
  agent: "specialist",
  state: "done",
  data: {},
  createdAt: 1,
  updatedAt: 1,
  ...o,
})

export const READY: Readiness = {
  sandbox: { ready: true, reason: "", building: false },
  claude: { ready: true, reason: "", plan: "Max" },
  model: { ready: true, reason: "", provider: "openrouter", model: "m" },
  ready: true,
  completed: true,
}

/** A conversation with a delegation: messages in markdown, a tool call, the specialist's run, a plan and usage. */
export function conversation(): { steps: StepRow[]; events: EventRow[] } {
  const delegation = step({
    data: {
      callId: "c1",
      context: {
        brief: "An ELF parser.",
        objective: "Map the parser",
        mode: "read",
        files: ["src/main.c"],
        questions: ["Where is the header read?"],
        constraints: [],
        environment: [],
        excerpts: [],
      },
      report: "The header is read in **parse_header**.",
      evidence: [{ path: "src/main.c", startLine: 3, endLine: 9, claim: "the header is read here" }],
    },
  })
  return {
    steps: [
      delegation,
      step({ id: "t1", kind: "todo", title: "Read the parser", state: "done" }),
      step({ id: "t2", kind: "todo", title: "Write the client", state: "running" }),
    ],
    events: [
      event("message.user", { output: "Map the protocol" }, { agent: "app" }),
      event("message.agent", { output: "Here is **what** I found:\n\n```c\nint main(void) { return 0; }\n```" }),
      event("tool.call", { tool: "read_file", callId: "r1", input: JSON.stringify({ file_path: "/workspace/src/main.c" }) }),
      event("tool.result", { tool: "read_file", callId: "r1", output: "int main(void) { return 0; }" }),
      event("tool.call", { tool: "delegate_to_specialist", callId: "c1", input: JSON.stringify({ objective: "Map the parser" }) }),
      event("specialist.thinking", { output: "The header comes first." }, { agent: "specialist", stepId: "s1", summary: "The header comes first." }),
      event("specialist.tool.call", { tool: "Bash", callId: "b1", input: '{"command":"make"}' }, { agent: "specialist", stepId: "s1", summary: "Bash make" }),
      event("specialist.tool.progress", { tool: "Bash", callId: "b1", elapsedSeconds: 30 }, { agent: "specialist", stepId: "s1" }),
      event("tool.result", { tool: "delegate_to_specialist", callId: "c1", output: "{}" }),
    ],
  }
}

export const history = (o: Partial<TaskHistory> = {}): TaskHistory => ({
  task: task(),
  ...conversation(),
  usage: [
    { agent: "orchestrator", calls: 3, tokensIn: 1200, tokensOut: 300, costUsd: 0.02, estimate: false },
    { agent: "specialist", calls: 1, tokensIn: 9000, tokensOut: 800, costUsd: 0.05, estimate: true },
  ],
  patches: [],
  hasMore: false,
  hasOlder: false,
  ...o,
})

/** A scripted API: each method answers from `script`, or with a harmless default; every call is recorded. */
export function scriptedApi(script: Partial<Record<ApiMethod, (...args: never[]) => unknown>> = {}) {
  const calls: { method: ApiMethod; args: unknown[] }[] = []
  // The OpenRouter orchestrator and Claude Code specialist these screens were scripted on, whatever the defaults are.
  const settings: Settings = { ...DEFAULT_SETTINGS, provider: "openrouter", model: DEFAULT_MODEL, specialistProvider: "claude", setupCompleted: true }
  const defaults: Partial<Record<ApiMethod, (...args: never[]) => unknown>> = {
    getSettings: () => settings,
    readiness: () => READY,
    listProjects: () => [project()],
    getProject: () => ({ project: project(), tasks: [task()], analyses: [], unknowns: [] }),
    getTask: () => history(),
    listTasks: () => [task()],
    sandboxStatus: () => ({ docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "2.1.310" }),
    loginStatus: () => ({ loggedIn: true, method: "claude.ai", inProgress: false, url: null, text: "", error: "" }),
    keyStatus: () => ({ set: true, hint: "…abcd", encryption: true }),
    listModels: () => ["m", "other/model"],
    detectTarget: (path: never) => ({ path, kind: "folder", isFile: false, size: 0, label: "Folder", engines: ["Ghidra"] }),
    saveSettings: (patch: never) => ({ ...settings, ...(patch as object) }),
  }
  const api = new Proxy({} as Api, {
    get:
      (_t, method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method: method as ApiMethod, args })
        const fn = script[method as ApiMethod] ?? defaults[method as ApiMethod]
        return fn ? (fn as (...a: unknown[]) => unknown)(...args) : null
      },
  })
  return { api, calls, called: (m: ApiMethod) => calls.filter((c) => c.method === m) }
}

export function pushBus() {
  const fns = new Set<(p: Push) => void>()
  const bus: Bus = { on: (fn) => (fns.add(fn), () => void fns.delete(fn)) }
  return { bus, push: (p: Push) => fns.forEach((f) => f(p)) }
}

export type Screen = Awaited<ReturnType<typeof render>>

/** The App rendered at 120×40, with helpers to wait for a frame and type. */
export async function render(o: {
  api: Api
  bus?: Bus
  start?: Route
  folder?: string
  args?: { continue: boolean; resume: boolean }
  width?: number
  height?: number
}) {
  const quits: number[] = []
  const t = await testRender(
    <App
      api={o.api}
      bus={o.bus ?? pushBus().bus}
      theme={DARK}
      where={{
        folder: o.folder ?? FOLDER,
        platform: process.platform as "win32",
        home: process.platform === "win32" ? "C:\\Users\\ana" : "/home/ana",
        dataDir: DATA,
        env: {},
      }}
      args={o.args ?? { continue: false, resume: false }}
      quit={() => quits.push(1)}
      start={o.start}
    />,
    { width: o.width ?? 120, height: o.height ?? 40, exitOnCtrlC: false },
  )
  const frame = () => t.captureCharFrame()
  /** Waits until the frame shows `text` (or the predicate holds), drawing frames as it goes. */
  const until = async (want: string | (() => boolean), ms = 3000) => {
    const ok = () => (typeof want === "string" ? frame().includes(want) : want())
    const end = Date.now() + ms
    while (Date.now() < end) {
      await t.renderOnce()
      if (ok()) return
      await Bun.sleep(15)
    }
    throw new Error(`Timed out waiting for ${typeof want === "string" ? JSON.stringify(want) : "a condition"}.\n${frame()}`)
  }
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i++) {
      await Bun.sleep(15)
      await t.renderOnce()
    }
  }
  const type = async (text: string) => {
    await t.mockInput.typeText(text)
    await settle()
  }
  const NAMES: Record<string, string> = {
    escape: "ESCAPE",
    tab: "TAB",
    return: "RETURN",
    up: "ARROW_UP",
    down: "ARROW_DOWN",
    left: "ARROW_LEFT",
    right: "ARROW_RIGHT",
    backspace: "BACKSPACE",
    home: "HOME",
    end: "END",
  }
  const press = async (key: string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => {
    t.mockInput.pressKey((NAMES[key] ?? key) as never, mods)
    await settle()
  }
  const enter = async () => {
    t.mockInput.pressEnter()
    await settle()
  }
  return { ...t, frame, until, settle, type, press, enter, quits }
}
