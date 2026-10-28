import { spawn } from "node:child_process"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { LoginStatus, SandboxStatus } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { getSettings, saveSettings } from "../src/main/settings"
import { CLAUDE_CODE_VERSION, SPECIALIST_IMAGE, type Exec } from "../src/main/sandbox/docker"
import { LoginService, SandboxService } from "../src/main/status"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"

/* specs/desktop-ui R1: what Settings reads and drives. */

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs")

describe("settings (R1.1)", () => {
  beforeAll(() => openDb(":memory:"))
  afterAll(() => closeDb())

  it("returns the defaults until changed, then merges each change", () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    saveSettings({ model: "z-ai/glm-5.3-flash" })
    expect(saveSettings({ discardOnCompletion: false })).toEqual({ ...DEFAULT_SETTINGS, model: "z-ai/glm-5.3-flash", discardOnCompletion: false })
  })
})

describe("SandboxService (R1.2)", () => {
  const exec =
    (ok: boolean): Exec =>
    async (args) => {
      if (args[0] === "build") return { code: ok ? 0 : 1, stdout: "step\n", stderr: ok ? "" : "failed to verify\n" }
      if (args[0] === "version") return { code: 0, stdout: "29\n", stderr: "" }
      if (args.join(" ").startsWith(`image inspect ${SPECIALIST_IMAGE}`)) return { code: 0, stdout: CLAUDE_CODE_VERSION, stderr: "" }
      if (args[0] === "inspect") return { code: 0, stdout: "true", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }

  it("reports Docker and images, and pushes each change", async () => {
    const seen: SandboxStatus[] = []
    const s = new SandboxService(exec(true), "/sandbox", (x) => seen.push(x))
    expect(await s.status()).toMatchObject({ docker: true, images: true, building: false, claudeVersion: CLAUDE_CODE_VERSION })
    expect(seen).toHaveLength(1)
  })

  it("builds once at a time and records the log", async () => {
    const s = new SandboxService(exec(true), "/sandbox")
    const b = s.build()
    expect(b.status.building).toBe(true)
    expect(s.build().status.building).toBe(true)
    expect(await s.status()).toMatchObject({ building: true })
    const done = await b.done
    expect(done.building).toBe(false)
    expect(done.buildLog).toContain("Done.")
  })

  it("keeps the failure in the log", async () => {
    const done = await new SandboxService(exec(false), "/sandbox").build().done
    expect(done.buildLog).toContain("failed to verify")
    expect(done.buildLog).toContain("The build failed.")
  })
})

describe("LoginService (R1.3)", () => {
  const start = (mode: string) => (sub: string[]) =>
    spawn(process.execPath, [FAKE, "auth", ...sub], { env: { ...process.env, HFR_FAKE: mode }, stdio: ["pipe", "pipe", "pipe"] })

  it("refreshes the state and logs out", async () => {
    const s = new LoginService(start("answer"))
    expect(await s.refresh()).toMatchObject({ loggedIn: true, plan: "max", inProgress: false, url: null })
    expect((await s.logout()).loggedIn).toBe(true)
    expect(() => s.sendCode("whatever-123")).toThrow(/No sign-in/)
  })

  it("shows the Anthropic URL while signing in and finishes with the code", async () => {
    const seen: LoginStatus[] = []
    const s = new LoginService(start("answer"), (x) => seen.push(x))
    const l = s.start()
    expect(l.status.inProgress).toBe(true)
    expect(s.start().status.inProgress).toBe(true)
    for (let i = 0; i < 50 && !s.url(); i++) await new Promise((r) => setTimeout(r, 50))
    expect(s.url()).toMatch(/^https:\/\/claude\.com\//)
    expect(seen.some((x) => x.url)).toBe(true)
    s.sendCode("good-code-123")
    const done = await l.done
    expect(done).toMatchObject({ inProgress: false, loggedIn: true, error: "" })
  })

  it("reports a failed sign-in and can cancel", async () => {
    const s = new LoginService(start("logged-out"))
    const l = s.start()
    for (let i = 0; i < 50 && !s.url(); i++) await new Promise((r) => setTimeout(r, 50))
    s.cancel()
    expect((await l.done).error).not.toBe("")
    expect(s.url()).toBeNull()
  })
})
