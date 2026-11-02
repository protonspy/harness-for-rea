import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ApiMethod } from "../../src/shared/api"
import { conversation, event, history, project, render, scriptedApi, task, type Screen } from "./support"

/*
  Parity with the desktop app (plans/tui-revamp 1.6): every API method the renderer's views and components call is
  reached by running the TUI — its screens, commands and dialogs driven with keys — not by reading its source.
*/

const reached = new Set<ApiMethod>()
const ID = task().id

/** Runs a flow on a fresh screen with a recording API; every method it reaches counts. */
async function flow(
  script: Parameters<typeof scriptedApi>[0],
  start: Parameters<typeof render>[0]["start"],
  steps: (s: Screen) => Promise<void>,
  folder?: string,
) {
  const api = scriptedApi(script)
  const s = await render({ api: api.api, start, folder })
  try {
    await steps(s)
  } finally {
    for (const c of api.calls) reached.add(c.method)
    await s.dispose()
  }
}
const run = async (s: Screen, line: string) => {
  await s.type(line)
  await s.enter()
}

/** The API methods the desktop app's views and components call, from their source. */
function rendererMethods(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name)) for (const m of readFileSync(p, "utf8").matchAll(/\bapi\.([a-zA-Z]+)\(/g)) out.add(m[1])
    }
  }
  walk(join(import.meta.dir, "..", "..", "src", "renderer", "src"))
  return out
}

describe("parity with the desktop app (plans/tui-revamp 1.6)", () => {
  test("opens the folder's project and its tasks, and every project's recent tasks", async () => {
    await flow({ startTask: () => task() }, undefined, async (s) => {
      await s.until("Analyses (0)")
      await run(s, "Find the key")
      await s.until("[awaiting-user]")
      await run(s, "/tasks")
      await s.until("Recent tasks")
    })
  })

  test("drives a task through each of its states' actions", async () => {
    const states = {
      "awaiting-user": ["/model other/model", "/close"],
      running: ["/stop", "/cancel"],
      stopped: ["/continue"],
      failed: ["/start-over"],
      done: ["/delete"],
    } as const
    for (const [state, commands] of Object.entries(states))
      await flow({ getTask: () => history({ task: task({ state: state as never }) }), retryTask: () => task() }, { kind: "task", id: ID }, async (s) => {
        await s.until(`[${state}]`)
        for (const c of commands) await run(s, c)
        if (state === "done") {
          await s.until("Delete this task")
          await s.press("y")
        }
        await run(s, "a message")
        await s.settle(10)
      })
  })

  test("answers a question, decides a gated call and a patch", async () => {
    const c = conversation()
    c.events.push(
      event("question.asked", { questionId: "q1", question: { prompt: "Which?", reason: "r", kind: "yesno", default: true } }),
      event("approval.requested", { calls: [{ callId: "g1", name: "execute", args: {} }] }),
    )
    const patch = {
      id: "00000000-0000-4000-8000-000000000099",
      taskId: ID,
      stepId: "s1",
      state: "proposed",
      files: [],
      diff: "+x\n",
      conflicts: [],
      createdAt: 1,
    }
    await flow({ getTask: () => history({ ...c, task: task({ state: "awaiting-user" }), patches: [patch as never] }) }, { kind: "task", id: ID }, async (s) => {
      await s.until("Which?")
      await s.enter()
      await s.until("The agent wants to run execute")
      await s.enter()
      await s.settle(10)
      await run(s, "/approve-patch")
      await s.settle(10)
    })
  })

  test("runs every step of the setup", async () => {
    await flow(
      { loginStatus: () => ({ loggedIn: false, method: "none", inProgress: true, url: "https://claude.ai/x", text: "", error: "" }) },
      { kind: "setup" },
      async (s) => {
        await s.until("3 · Orchestrator's model")
        for (const c of [
          "/images",
          "/login",
          "/open-login",
          "/code abcdefgh1",
          "/cancel-login",
          "/logout",
          "/key sk-or-v1-000000000",
          "/remove-key",
          "/base-url https://x.dev/v1",
          "/done",
        ])
          await run(s, c)
        await run(s, "/model")
        await s.until("other/model")
        await s.enter()
        await s.settle(10)
      },
    )
  })

  test("creates a project with its target and folder picked, and deletes one", async () => {
    await flow(
      { listProjects: () => [], createProject: () => project(), pickTarget: () => "C:/target", pickFolder: () => "C:/projects" },
      undefined,
      async (s) => {
        await s.until("Folder, read in place")
        await s.press("o", { ctrl: true })
        await s.until("C:/target")
        await s.until("Folder, read in place")
        await s.press("t", { ctrl: true })
        await run(s, "/project-folder")
        await run(s, "/models")
        await s.until("other/model")
        await s.press("escape")
        await run(s, "/create")
        await s.settle(10)
      },
    )
    await flow({}, { kind: "project", id: project().id }, async (s) => {
      await s.until("Tasks (1)")
      await run(s, "/model other/model")
      await run(s, "/delete-project")
      await s.until("Type its name to confirm.")
      await s.type("app")
      await s.enter()
      await s.settle(10)
    })
  })

  test("reaches every API method the desktop app's views call", () => {
    const missing = [...rendererMethods()].filter((m) => !reached.has(m as ApiMethod)).sort()
    expect(rendererMethods().size).toBeGreaterThan(30)
    expect(missing).toEqual([])
  })
})
