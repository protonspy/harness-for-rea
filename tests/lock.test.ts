import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultDataDir, LOCKS_DIR, LockHeld, Locks, projectLockName, type Holder } from "../src/main/lock"

/* specs/shared-data-folder R1: a project held by one app at a time, a stale lock taken over. */

const dir = () => mkdtempSync(join(tmpdir(), "hfr-lock-"))
const desktop: Holder = { app: "desktop", pid: 1001, since: 10 }
const tui: Holder = { app: "tui", pid: 2002, since: 20 }
const busy = (h: Holder) => `held by ${h.app} (process ${h.pid})`
const file = (d: string, name: string) => join(d, LOCKS_DIR, `${name}.lock`)

describe("the locks of a shared data folder", () => {
  it("refuses a project another live app holds, naming it, and takes it once released (R1.1, R1.2)", () => {
    const d = dir()
    const a = new Locks(d, desktop, () => true)
    const b = new Locks(d, tui, () => true)
    const name = projectLockName("p1")
    const release = a.take(name, busy)
    expect(() => b.take(name, busy)).toThrow(LockHeld)
    expect(() => b.take(name, busy)).toThrow("held by desktop (process 1001)")
    expect(b.holder(name)).toEqual(desktop)
    expect(a.holder(name)).toBeNull()
    // another project is free
    b.take(projectLockName("p2"), busy)()
    release()
    expect(existsSync(file(d, name))).toBe(false)
    b.take(name, busy)
    expect(a.holder(name)).toEqual(tui)
  })

  it("lets the process holding a lock take it again", () => {
    const d = dir()
    const a = new Locks(d, desktop, () => true)
    a.take("x", busy)
    expect(() => a.take("x", busy)).not.toThrow()
  })

  it("takes over a lock whose process is gone, or that cannot be read and is old (R1.4)", () => {
    const d = dir()
    new Locks(d, desktop, () => true).take("p", busy)
    const b = new Locks(d, tui, (h) => h.pid !== 1001)
    expect(b.holder("p")).toBeNull()
    const release = b.take("p", busy)
    expect(JSON.parse(readFileSync(file(d, "p"), "utf8"))).toMatchObject({ app: "tui", pid: 2002, since: 20 })
    release()
    writeFileSync(file(d, "p"), "not json")
    expect(() => b.take("p", busy)).toThrow(/another app may be taking it/)
    utimesSync(file(d, "p"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    b.take("p", busy)()
  })

  it("tells a reused pid from the process that took the lock by its start time", () => {
    const d = dir()
    new Locks(d, { ...desktop, since: 1 }, () => true).take("p", busy)
    // the same pid, started later: not the holder, so the liveness check decides
    const again = new Locks(d, { ...desktop, since: 2 }, (h) => h.since !== 1)
    expect(again.holder("p")).toBeNull()
    again.take("p", busy)()
  })

  it("leaves alone a lock another process took after this one's went stale, and a takeover another is doing", () => {
    const d = dir()
    const a = new Locks(d, desktop, () => true)
    const release = a.take("p", busy)
    writeFileSync(file(d, "p"), JSON.stringify(tui))
    release()
    expect(existsSync(file(d, "p"))).toBe(true)

    writeFileSync(file(d, "q"), JSON.stringify(desktop))
    writeFileSync(`${file(d, "q")}.takeover`, "")
    const b = new Locks(d, tui, (h) => h.pid !== 1001)
    expect(() => b.take("q", busy)).toThrow(/another app may be taking it/)
    utimesSync(`${file(d, "q")}.takeover`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    b.take("q", busy)()
    expect(existsSync(`${file(d, "q")}.takeover`)).toBe(false)
  })

  it("lists what live apps other than this one hold (R1.3)", () => {
    const d = dir()
    new Locks(d, desktop, () => true).take(projectLockName("p1"), busy)
    new Locks(d, { app: "tui", pid: 3003, since: 30 }, () => true).take(projectLockName("p2"), busy)
    const mine = new Locks(d, tui, (h) => h.pid !== 3003)
    mine.take(projectLockName("p3"), busy)
    expect([...mine.held()]).toEqual([[projectLockName("p1"), desktop]])
  })

  it("finds the folder the desktop app keeps its data in, on each platform", () => {
    expect(defaultDataDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "Harness for REA"),
    )
    expect(defaultDataDir("darwin", {}, "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "Harness for REA"))
    expect(defaultDataDir("linux", {}, "/home/u")).toBe(join("/home/u", ".config", "Harness for REA"))
  })
})
