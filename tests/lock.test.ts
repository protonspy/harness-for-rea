import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DataFolderBusy, defaultDataDir, LOCK_FILE, lockDataFolder } from "../src/main/lock"

/* plans/finish-the-harness 1.9: one app on a data folder at a time. */

const dir = () => mkdtempSync(join(tmpdir(), "hfr-lock-"))

describe("the data folder's lock", () => {
  it("lets the second app know which app holds the folder, and refuses it", () => {
    const d = dir()
    const release = lockDataFolder(d, "desktop", 1001, () => true)
    expect(() => lockDataFolder(d, "tui", 2002, () => true)).toThrow(DataFolderBusy)
    expect(() => lockDataFolder(d, "tui", 2002, () => true)).toThrow(/already open in the desktop app \(process 1001\)/)
    release()
    expect(existsSync(join(d, LOCK_FILE))).toBe(false)
    const tui = lockDataFolder(d, "tui", 2002, () => true)
    expect(() => lockDataFolder(d, "desktop", 1001, () => true)).toThrow(/already open in the terminal UI \(process 2002\)/)
    tui()
  })

  it("takes over a lock whose process is gone, or that cannot be read", () => {
    const d = dir()
    lockDataFolder(d, "desktop", 1001, () => true)
    const release = lockDataFolder(d, "tui", 2002, (pid) => pid !== 1001)
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8"))).toMatchObject({ app: "tui", pid: 2002 })
    release()
    writeFileSync(join(d, LOCK_FILE), "not json")
    lockDataFolder(d, "desktop", 1001, () => true)()
  })

  it("checks a real process: this one holds it, a finished one does not", () => {
    const d = dir()
    const release = lockDataFolder(d, "desktop")
    expect(() => lockDataFolder(d, "tui", process.pid + 1)).toThrow(DataFolderBusy)
    release()
    writeFileSync(join(d, LOCK_FILE), JSON.stringify({ app: "tui", pid: 2 ** 30, since: 0 }))
    lockDataFolder(d, "desktop")()
  })

  it("leaves alone a lock another process took after this one's went stale", () => {
    const d = dir()
    const release = lockDataFolder(d, "desktop", 1001, () => true)
    writeFileSync(join(d, LOCK_FILE), JSON.stringify({ app: "tui", pid: 2002, since: 0 }))
    release()
    expect(existsSync(join(d, LOCK_FILE))).toBe(true)
  })

  it("finds the folder the desktop app keeps its data in, on each platform", () => {
    expect(defaultDataDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(join("C:\\Users\\u\\AppData\\Roaming", "Harness for REA"))
    expect(defaultDataDir("darwin", {}, "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "Harness for REA"))
    expect(defaultDataDir("linux", {}, "/home/u")).toBe(join("/home/u", ".config", "Harness for REA"))
  })
})
