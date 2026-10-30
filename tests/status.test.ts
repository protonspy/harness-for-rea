import { spawn } from "node:child_process"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { LoginStatus, SandboxStatus } from "../src/shared/types"
import { closeDb, openDb } from "../src/main/db"
import { getSettings, saveSettings } from "../src/main/settings"
import { BASE_IMAGE, CLAUDE_CODE_VERSION, SPECIALIST_IMAGE, type Exec } from "../src/main/sandbox/docker"
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

describe("SandboxService (R1.2, specs/sandbox-images R3)", () => {
  /** A Docker whose image is ready or not, whose build succeeds or not, and whose version answers or not. */
  const docker = (o: { ready: boolean; build?: boolean; running?: boolean }) => {
    const calls: string[] = []
    const state = { ready: o.ready, running: o.running ?? true }
    const exec: Exec = async (args) => {
      calls.push(args.join(" "))
      if (args[0] === "version") return state.running ? { code: 0, stdout: "29\n", stderr: "" } : { code: 1, stdout: "", stderr: "not running\n" }
      if (args[0] === "build") {
        if (o.build === false) return { code: 1, stdout: "step\n", stderr: "failed to verify\n" }
        state.ready = true
        return { code: 0, stdout: "step\n", stderr: "" }
      }
      if (args.join(" ").startsWith(`image inspect ${SPECIALIST_IMAGE}`))
        return state.ready ? { code: 0, stdout: `${CLAUDE_CODE_VERSION} ${BASE_IMAGE}`, stderr: "" } : { code: 1, stdout: "", stderr: "No such image" }
      return { code: 0, stdout: "", stderr: "" }
    }
    return { exec, calls, state }
  }
  const builds = (calls: string[]) => calls.filter((c) => c.startsWith("build")).length

  it("reports Docker and a ready image, and pushes each change, preparing nothing", async () => {
    const seen: SandboxStatus[] = []
    const d = docker({ ready: true })
    const s = new SandboxService(d.exec, "/sandbox", (x) => seen.push(x))
    expect(await s.status()).toMatchObject({ docker: true, images: true, building: false, claudeVersion: CLAUDE_CODE_VERSION })
    expect(seen).toHaveLength(1)
    expect(builds(d.calls)).toBe(0)
  })

  it("prepares a missing image on its own the first time it finds Docker running", async () => {
    const d = docker({ ready: false })
    const s = new SandboxService(d.exec, "/sandbox")
    expect(await s.status()).toMatchObject({ building: true })
    expect(d.calls).toContain(`pull ${BASE_IMAGE}`)
    const done = await s.build().done
    expect(done).toMatchObject({ building: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(await s.status()).toMatchObject({ images: true, building: false })
    expect(builds(d.calls)).toBe(1)
  })

  it("waits for Docker when it is not running at start", async () => {
    const d = docker({ ready: false, running: false })
    const s = new SandboxService(d.exec, "/sandbox")
    expect(await s.status()).toMatchObject({ docker: false, building: false })
    d.state.running = true
    expect(await s.status()).toMatchObject({ building: true })
  })

  it("prepares once at a time and records the log", async () => {
    const s = new SandboxService(docker({ ready: true }).exec, "/sandbox")
    const b = s.build()
    expect(b.status.building).toBe(true)
    expect(s.build().status.building).toBe(true)
    expect(await s.status()).toMatchObject({ building: true })
    const done = await b.done
    expect(done.building).toBe(false)
    expect(done.buildLog).toContain("Done.")
  })

  it("keeps a failure in the log and does not prepare again until asked", async () => {
    const d = docker({ ready: false, build: false })
    const s = new SandboxService(d.exec, "/sandbox")
    const done = await s.build().done
    expect(done.buildLog).toContain("failed to verify")
    expect(done.buildLog).toContain("Preparing the image failed.")
    expect(await s.status()).toMatchObject({ images: false, building: false })
    expect(builds(d.calls)).toBe(1)
    await s.build().done
    expect(builds(d.calls)).toBe(2)
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
