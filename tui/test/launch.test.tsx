import { afterEach, describe, expect, test } from "bun:test"
import { FOLDER, project, render, scriptedApi, task, type Screen } from "./support"

/* specs/tui-launch: what the TUI opens for the folder it is run in. */

let s: Screen | null = null
afterEach(async () => {
  await s?.dispose()
  s = null
})

describe("the folder the TUI runs in (specs/tui-launch R1)", () => {
  test("opens the one project whose target it is", async () => {
    const { api } = scriptedApi()
    s = await render({ api })
    await s.until("Analyses (0)")
    expect(s.frame()).toContain("Map the protocol")
  })

  test("offers to create a project on a folder no project has, prefilled", async () => {
    const { api } = scriptedApi({ listProjects: () => [] })
    s = await render({ api })
    await s.until("Ctrl+S creates the project")
    expect(s.frame()).toContain(FOLDER)
    // the target's kind, detected from the typed path
    await s.until("Folder, read in place")
    expect(s.frame()).toContain("Tab next field")
  })

  test("lists the projects to pick when several have the folder, with one more to create", async () => {
    const { api } = scriptedApi({
      listProjects: () => [project({ name: "first", createdAt: 1 }), project({ id: "00000000-0000-4000-8000-000000000002", name: "second", createdAt: 2 })],
    })
    s = await render({ api })
    await s.until("Several projects have this folder")
    expect(s.frame()).toContain("second")
    expect(s.frame()).toContain("Create another project on it")
  })

  test("opens the setup first when it is not completed (R2.1)", async () => {
    const { api } = scriptedApi({ getSettings: () => ({ setupCompleted: false, provider: "openrouter", model: "m" }) as never })
    s = await render({ api })
    await s.until("1 · Sandbox images")
    expect(s.frame()).toContain("/done finishes the setup")
  })

  test("reopens the folder's last task with --continue (R2.2)", async () => {
    const { api, called } = scriptedApi({ getProject: () => ({ project: project(), tasks: [task({ request: "Latest work" })], analyses: [], unknowns: [] }) })
    s = await render({ api, args: { continue: true, resume: false } })
    await s.until(() => called("getTask").length > 0)
    expect(called("getTask")[0].args[0]).toBe(task().id)
  })
})
