import { afterEach, describe, expect, test } from "bun:test"
import { render, scriptedApi, task, type Screen } from "./support"

/* specs/tui-shell: the frame, the keys, the commands, the dialogs. */

let s: Screen | null = null
afterEach(async () => {
  await s?.dispose()
  s = null
})

describe("the shell (specs/tui-shell)", () => {
  test("lays out the status line with the screen's title and state, the prompt and the key hints (R1.1, R1.2)", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    const f = s.frame()
    expect(f).toContain("Harness for REA")
    expect(f).toContain("Map the protocol")
    expect(f).toContain("[awaiting-user]")
    expect(f).toContain("? keys")
    expect(f).toContain("Tab prompt or transcript")
  })

  test("? lists every key reachable on the screen, by layer, and every command (R2.1)", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    await s.type("?")
    await s.until("Esc or ? closes")
    const f = s.frame()
    for (const key of ["Ctrl+P", "Ctrl+B", "Ctrl+O", "Tab", "PgUp", "PgDn", "Esc", "Ctrl+C"]) expect(f).toContain(key)
    for (const group of ["Task", "Prompt", "Everywhere"]) expect(f).toContain(group)
    for (const cmd of ["/close", "/delete", "/events", "/expand", "/projects", "/settings", "/quit"]) expect(f).toContain(cmd)
    await s.press("escape")
    await s.until(() => !s!.frame().includes("Esc or ? closes"))
  })

  test("a typed ? is part of a message, not the help", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    await s.type("why?")
    expect(s.frame()).toContain("why?")
    expect(s.frame()).not.toContain("Esc or ? closes")
  })

  test("/ lists the screen's commands with the global ones, narrowed as typed and completed with Tab (R2.2)", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    await s.type("/")
    await s.until("/settings")
    for (const cmd of ["/close", "/delete", "/events", "/expand"]) expect(s.frame()).toContain(cmd)
    await s.type("eve")
    await s.until(() => !s!.frame().includes("/close"))
    expect(s.frame()).toContain("Open the task's event log")
    await s.press("tab")
    await s.until("Filter: [all]")
  })

  test("Ctrl+P opens the palette over the same commands, searchable, and runs the one picked (R2.3)", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    await s.press("p", { ctrl: true })
    await s.until("Commands")
    for (const cmd of ["/close", "/delete", "/events", "/projects", "/settings", "/quit"]) expect(s.frame()).toContain(cmd)
    await s.type("settings")
    await s.enter()
    await s.until("Delegation timeout (minutes)")
  })

  test("Ctrl+C clears the prompt, then asks for a second press before it quits (R2.5)", async () => {
    const { api } = scriptedApi()
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("[awaiting-user]")
    await s.type("draft")
    await s.press("c", { ctrl: true })
    expect(s.frame()).not.toContain("draft")
    await s.press("c", { ctrl: true })
    await s.until("Press Ctrl+C again to quit.")
    expect(s.quits).toHaveLength(0)
    await s.press("c", { ctrl: true })
    expect(s.quits).toHaveLength(1)
  })

  test("says a failed action in a toast (R3.2) and strips control characters from what it draws (R3.3)", async () => {
    const { api } = scriptedApi({
      getTask: () => ({ ...history(), task: task({ request: "Map \u001b]0;pwned\u0007 it" }) }),
      closeTask: () => {
        throw new Error("The task is busy.")
      },
    })
    s = await render({ api, start: { kind: "task", id: task().id } })
    await s.until("Map ]0;pwned it")
    expect(s.frame()).not.toContain("\u001b")
    await s.type("/close")
    await s.enter()
    await s.until("The task is busy.")
  })
})

import { history } from "./support"
