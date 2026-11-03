import { afterEach, describe, expect, test } from "bun:test"
import { DATA, history, project, pushBus, render, scriptedApi, task, type Screen } from "./support"

/* specs/tui-panels and the rest of specs/tui-launch: setup, settings, event log, project overview, new project. */

let current: Screen | null = null
afterEach(async () => {
  await current?.dispose()
  current = null
})
const show = async (o: Parameters<typeof render>[0]) => (current = await render(o))
const notReady = {
  sandbox: { ready: false, reason: "Docker is not running.", building: false },
  claude: { ready: false, reason: "Sign Claude in.", plan: undefined },
  model: { ready: false, reason: "Set your OpenRouter API key.", provider: "openrouter" as const, model: "m" },
  ready: false,
  completed: false,
}

describe("the setup (specs/tui-panels R3)", () => {
  test("shows the three steps with what readies each, and the build log as it runs (R3.1, R3.2)", async () => {
    const bus = pushBus()
    const { api, called } = scriptedApi({ readiness: () => notReady })
    const s = await show({ api, bus: bus.bus, start: { kind: "setup" } })
    await s.until("1 · Sandbox images")
    for (const part of ["Docker is not running.", "2 · Claude sign-in", "Sign Claude in.", "3 · Orchestrator's model", "Set your OpenRouter API key."])
      expect(s.frame()).toContain(part)
    bus.push({
      type: "sandbox",
      status: { docker: true, dockerError: "", images: false, building: true, buildLog: "Pulling the base\nStep 2/4\n", claudeVersion: "2.1.310" },
    })
    await s.until("Step 2/4")
    await s.type("/images")
    await s.enter()
    await s.until(() => called("buildSandbox").length === 1)
  })

  test("signs in through the browser, takes the code, cancels and signs out (R3.3)", async () => {
    const { api, called } = scriptedApi({
      loginStatus: () => ({ loggedIn: false, method: "none", inProgress: true, url: "https://claude.ai/oauth/x", text: "", error: "" }),
    })
    const s = await show({ api, start: { kind: "setup" } })
    await s.until("https://claude.ai/oauth/x")
    for (const [cmd, method] of [
      ["/open-login", "openLoginUrl"],
      ["/code abcdefgh1234", "sendLoginCode"],
      ["/cancel-login", "cancelLogin"],
      ["/logout", "logout"],
      ["/login", "startLogin"],
    ] as const) {
      await s.type(cmd)
      await s.enter()
      await s.until(() => called(method).length === 1)
    }
    expect(called("sendLoginCode")[0].args).toEqual(["abcdefgh1234"])
  })

  test("picks the provider, sets the base URL and the key, removes it, and picks the model from the list (R3.4)", async () => {
    const { api, called } = scriptedApi()
    const s = await show({ api, start: { kind: "setup" } })
    await s.until("3 · Orchestrator's model")
    await s.type("/key sk-or-v1-0123456789")
    await s.enter()
    await s.until(() => called("saveKey").length === 1)
    expect(called("saveKey")[0].args).toEqual(["sk-or-v1-0123456789", "openrouter"])
    await s.type("/remove-key")
    await s.enter()
    await s.until(() => called("clearKey").length === 1)
    await s.type("/base-url https://api.example.com/v1")
    await s.enter()
    await s.until(() => called("saveSettings").length === 1)
    await s.type("/model")
    await s.enter()
    await s.until("other/model")
    await s.press("down")
    await s.enter()
    await s.until(() => called("saveSettings").some((c) => JSON.stringify(c.args).includes("other/model")))
    expect(called("listModels")).toHaveLength(1)
    await s.type("/provider")
    await s.enter()
    await s.until("DeepSeek")
    await s.press("down")
    await s.enter()
    await s.until(() => called("saveSettings").some((c) => JSON.stringify(c.args).includes('"provider":"deepseek"')))
  })

  test("finishes with /done and goes on (R3.1)", async () => {
    const ready = {
      ...notReady,
      sandbox: { ready: true, reason: "", building: false },
      claude: { ready: true, reason: "" },
      model: { ...notReady.model, ready: true, reason: "" },
      ready: true,
    }
    const { api, called } = scriptedApi({ readiness: () => ready, completeSetup: () => ({ ...ready, completed: true }) })
    const s = await show({ api, start: { kind: "setup", then: { kind: "settings" } } })
    await s.until("Every step is ready")
    await s.type("/done")
    await s.enter()
    await s.until(() => called("completeSetup").length === 1)
    await s.until("Delegation inactivity timeout (minutes)")
  })

  test("shows a banner when a step stops being ready after the setup, naming it (R3.5)", async () => {
    const { api } = scriptedApi({
      readiness: () => ({ ...notReady, claude: { ready: true, reason: "" }, model: { ...notReady.model, ready: true, reason: "" }, completed: true }),
    })
    const s = await show({ api, start: { kind: "task", id: task().id } })
    await s.until("The sandbox images stopped being ready. Type /setup to fix it.")
  })
})

describe("settings (specs/tui-panels R4)", () => {
  test("changes the efforts and the timeouts, and opens the setup again", async () => {
    const { api, called } = scriptedApi()
    const s = await show({ api, start: { kind: "settings" } })
    await s.until("Delegation inactivity timeout (minutes)")
    await s.press("right")
    await s.until(() => called("saveSettings").some((c) => JSON.stringify(c.args).includes("orchestratorEffort")))
    await s.press("tab")
    await s.press("right")
    await s.until(() => called("saveSettings").some((c) => JSON.stringify(c.args).includes("specialistEffort")))
    await s.press("tab")
    await s.press("backspace")
    await s.press("backspace")
    await s.press("backspace")
    await s.type("45")
    await s.enter()
    await s.until(() => called("saveSettings").some((c) => JSON.stringify(c.args) === '[{"timeoutMinutes":45}]'))
    await s.press("t", { ctrl: true })
    await s.type("/setup")
    await s.enter()
    await s.until("1 · Sandbox images")
  })
})

describe("the event log (specs/tui-panels R1.2)", () => {
  test("lists the task's events, filters them by agent, and opens one's payload", async () => {
    const { api } = scriptedApi()
    const s = await show({ api, start: { kind: "events", taskId: task().id } })
    await s.until("Filter: [all]")
    expect(s.frame()).toContain("specialist.thinking")
    await s.press("tab")
    await s.until("[orchestrator]")
    expect(s.frame()).not.toContain("specialist.thinking")
    await s.enter()
    await s.until("Esc closes")
  })
})

describe("a project's overview (specs/tui-panels R2.1, R2.2)", () => {
  test("gives the prompt back its keys when the user comes back from a task opened from the list", async () => {
    const { api, called } = scriptedApi({ startTask: () => task() })
    const s = await show({ api, start: { kind: "project", id: project().id } })
    await s.until("Tasks (1)")
    await s.press("tab")
    await s.enter()
    await s.until("[awaiting-user]")
    await s.press("escape")
    await s.until("Tasks (1)")
    await s.type("A new request")
    await s.enter()
    await s.until(() => called("startTask").length === 1)
    expect(called("startTask")[0].args).toEqual([{ projectId: project().id, request: "A new request" }])
  })

  test("shows its target, tasks, analyses and unknowns, and starts a task from the prompt", async () => {
    const { api, called } = scriptedApi({
      getProject: () => ({
        project: project(),
        tasks: [task()],
        analyses: [{ id: "a1", taskId: task().id, state: "done", objective: "Map the parser", evidence: 3, createdAt: 1 }],
        unknowns: [
          {
            id: "u1",
            projectId: project().id,
            question: "Is the checksum CRC32?",
            severity: "high",
            probes: [],
            settle: "",
            raisedBy: "s1",
            closedBy: null,
            resolution: "",
            createdAt: 1,
          },
        ],
      }),
      startTask: () => task({ id: "00000000-0000-4000-8000-000000000011", request: "Find the key" }),
      getTask: () => history({ task: task({ id: "00000000-0000-4000-8000-000000000011", request: "Find the key" }) }),
    })
    const s = await show({ api, start: { kind: "project", id: project().id } })
    await s.until("Analyses (1)")
    for (const part of ["Map the parser", "3 evidence", "Is the checksum CRC32?", "Open unknowns (1 of 1)", "Map the protocol"])
      expect(s.frame()).toContain(part)
    await s.type("Find the key")
    await s.enter()
    await s.until(() => called("startTask").length === 1)
    expect(called("startTask")[0].args).toEqual([{ projectId: project().id, request: "Find the key" }])
    await s.until("[awaiting-user]")
  })

  test("changes the model and efforts the project's tasks run with, picked from the provider's list (specs/projects R1.8)", async () => {
    const { api, called } = scriptedApi()
    const s = await show({ api, start: { kind: "project", id: project().id } })
    await s.until("Tasks (1)")
    await s.type("/model")
    await s.enter()
    await s.until("other/model")
    await s.press("down")
    await s.enter()
    await s.until(() => called("updateProject").length === 1)
    expect(called("updateProject")[0].args).toEqual([project().id, { model: "other/model" }])
    await s.type("/specialist-effort")
    await s.enter()
    await s.until("Specialist's effort")
    await s.press("down")
    await s.enter()
    await s.until(() => called("updateProject").length === 2)
    expect(called("updateProject")[1].args).toEqual([project().id, { specialistEffort: "high" }])
  })

  test("deletes the project only after its name is typed", async () => {
    const { api, called } = scriptedApi()
    const s = await show({ api, start: { kind: "project", id: project().id } })
    await s.until("Tasks (1)")
    await s.type("/delete-project")
    await s.enter()
    await s.until("Type its name to confirm.")
    await s.type("wrong")
    await s.enter()
    await s.until("That is not the project's name.")
    for (let i = 0; i < 5; i++) await s.press("backspace")
    await s.type("app")
    await s.enter()
    await s.until(() => called("deleteProject").length === 1)
  })

  test("shows a project another app holds as taken, starting no task there", async () => {
    const { api } = scriptedApi({ getProject: () => ({ project: project({ heldBy: { app: "desktop", pid: 77 } }), tasks: [], analyses: [], unknowns: [] }) })
    const s = await show({ api, start: { kind: "project", id: project().id } })
    await s.until("In use by the desktop app (process 77)")
  })
})

describe("creating a project (specs/tui-panels R2.3, specs/tui-launch R1.5, R1.6)", () => {
  test("creates it from the prefilled form", async () => {
    const { api, called } = scriptedApi({ listProjects: () => [], createProject: () => project({ id: "00000000-0000-4000-8000-000000000005" }) })
    const s = await show({ api })
    await s.until("Folder, read in place")
    await s.press("s", { ctrl: true })
    await s.until(() => called("createProject").length === 1)
    expect(called("createProject")[0].args[0]).toMatchObject({ name: "app", goal: "understand", provider: "openrouter" })
  })

  test("asks for a home folder's path typed before creating a project on it", async () => {
    const home = process.platform === "win32" ? "C:\\Users\\ana" : "/home/ana"
    const { api, called } = scriptedApi({ listProjects: () => [], createProject: () => project() })
    const s = await show({ api, folder: home })
    await s.until("your home folder")
    await s.until("Folder, read in place")
    await s.press("s", { ctrl: true })
    await s.until("Mount a broad folder?")
    await s.type("nope")
    await s.enter()
    await s.until("That is not the same path.")
    expect(called("createProject")).toHaveLength(0)
    for (let i = 0; i < 4; i++) await s.press("backspace")
    await s.type(home)
    await s.enter()
    await s.until(() => called("createProject").length === 1)
  })

  test("refuses the app's own data folder", async () => {
    const { api, called } = scriptedApi({ listProjects: () => [] })
    const s = await show({ api, folder: DATA })
    await s.until("This is the app's own data folder")
    expect(called("createProject")).toHaveLength(0)
  })

  test("browses for the target with the terminal's picker, standing in for the desktop dialog", async () => {
    const { api, called } = scriptedApi({ listProjects: () => [], pickTarget: () => "C:\\elsewhere\\bin" })
    const s = await show({ api })
    await s.until("Ctrl+O browses")
    await s.press("o", { ctrl: true })
    await s.until(() => called("pickTarget").length === 1)
    await s.until("elsewhere")
  })
})
