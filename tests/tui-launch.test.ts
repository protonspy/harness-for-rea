import { describe, expect, it } from "vitest"
import type { ProjectRow } from "../src/shared/types"
import { launchPlan, matchProjects, riskOf, samePath } from "../tui/src/lib/launch"

/* specs/tui-launch R1: the folder the TUI runs in as the project's target. */

const winEnv = { USERPROFILE: "C:\\Users\\ana", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\ana" }
const win = { platform: "win32" as const, home: "C:\\Users\\ana", dataDir: "C:\\Users\\ana\\AppData\\Roaming\\Harness for REA", env: winEnv }
const mac = { platform: "darwin" as const, home: "/Users/ana", dataDir: "/Users/ana/Library/Application Support/Harness for REA", env: {} }

const project = (id: string, targetPath: string, createdAt = 0): ProjectRow => ({
  id,
  name: id,
  goal: "understand",
  targetPath,
  targetKind: "folder",
  sourceRoot: targetPath,
  folder: `C:/p/${id}`,
  ownsFolder: true,
  provider: "openrouter",
  model: "m",
  orchestratorEffort: "medium",
  specialistEffort: "medium",
  createdAt,
  updatedAt: createdAt,
})

describe("a folder too broad to mount (R1.5, R1.6)", () => {
  it("asks for the home folder, a drive or root, and a Downloads folder", () => {
    expect(riskOf("C:\\Users\\ana", win)).toEqual({ kind: "confirm", why: "your home folder" })
    expect(riskOf("c:\\users\\ana\\", win)).toEqual({ kind: "confirm", why: "your home folder" })
    expect(riskOf("C:\\", win)).toEqual({ kind: "confirm", why: "the root of a drive" })
    expect(riskOf("D:\\", win)).toEqual({ kind: "confirm", why: "the root of a drive" })
    expect(riskOf("C:\\Users\\ana\\Downloads", win)).toEqual({ kind: "confirm", why: "a Downloads folder" })
    expect(riskOf("/", mac)).toEqual({ kind: "confirm", why: "the root of the file system" })
    expect(riskOf("/Users/ana", mac)).toEqual({ kind: "confirm", why: "your home folder" })
    expect(riskOf("/Users/ana/Downloads", mac)).toEqual({ kind: "confirm", why: "a Downloads folder" })
  })

  it("asks for a folder holding the app's data, and refuses the data folder and what is inside it", () => {
    expect(riskOf("C:\\Users\\ana\\AppData", win)).toEqual({ kind: "confirm", why: "a folder holding the app's data" })
    expect(riskOf("C:\\Users\\ana\\AppData\\Roaming\\Harness for REA", win).kind).toBe("refuse")
    expect(riskOf("C:\\Users\\ana\\AppData\\Roaming\\harness for rea\\projects\\x", win).kind).toBe("refuse")
    expect(riskOf("/Users/ana/Library/Application Support/Harness for REA/tasks", mac).kind).toBe("refuse")
  })

  it("lets an ordinary folder through, and one merely named like a risky one", () => {
    expect(riskOf("C:\\Users\\ana\\samples\\app", win)).toEqual({ kind: "ok" })
    expect(riskOf("C:\\Users\\ana\\Downloads\\sample", win)).toEqual({ kind: "ok" })
    expect(riskOf("C:\\Users\\anabel", win)).toEqual({ kind: "ok" })
    expect(riskOf("/Users/ana/work", mac)).toEqual({ kind: "ok" })
  })
})

describe("projects on a folder (R1.2, R1.3)", () => {
  it("compares paths across separators, a trailing separator and, on Windows, case", () => {
    expect(samePath("C:\\Samples\\App\\", "c:/samples/app", "win32")).toBe(true)
    expect(samePath("/a/B", "/a/b", "darwin")).toBe(false)
    expect(samePath("/a/b/", "/a/b", "linux")).toBe(true)
  })

  it("finds the projects whose target is the folder, newest first", () => {
    const list = [project("old", "C:/s/app", 1), project("other", "C:/s/else", 5), project("new", "c:\\s\\app\\", 9)]
    expect(matchProjects(list, "C:\\s\\app", "win32").map((p) => p.id)).toEqual(["new", "old"])
    expect(matchProjects(list, "C:\\s\\none", "win32")).toEqual([])
  })
})

describe("what the TUI opens first (R1.2–R1.6, R2.1–R2.3)", () => {
  const base = { folder: "C:\\s\\app", platform: "win32" as const, risk: { kind: "ok" } as const, setupCompleted: true, continue: false, resume: false }

  it("runs the setup first when it is not completed", () => {
    expect(launchPlan({ ...base, setupCompleted: false, projects: [] })).toEqual({ kind: "setup" })
  })

  it("opens the one project, picks among several, or creates one", () => {
    expect(launchPlan({ ...base, projects: [project("a", "C:/s/app")] })).toEqual({ kind: "open", projectId: "a" })
    expect(launchPlan({ ...base, projects: [project("a", "C:/s/app", 1), project("b", "C:/s/app", 2)] })).toEqual({ kind: "pick", projectIds: ["b", "a"] })
    expect(launchPlan({ ...base, projects: [] })).toEqual({ kind: "create", confirm: null })
  })

  it("asks for the path typed before creating on a broad folder, and refuses the data folder", () => {
    expect(launchPlan({ ...base, risk: { kind: "confirm", why: "your home folder" }, projects: [] })).toEqual({ kind: "create", confirm: "your home folder" })
    expect(launchPlan({ ...base, risk: { kind: "refuse", why: "x" }, projects: [] })).toEqual({ kind: "refuse", why: "x" })
    // a project already on it opens: it was confirmed when it was created
    expect(launchPlan({ ...base, risk: { kind: "confirm", why: "your home folder" }, projects: [project("a", "C:/s/app")] })).toEqual({ kind: "open", projectId: "a" })
  })

  it("opens the last task with continue, and the task picker with resume", () => {
    const one = [project("a", "C:/s/app")]
    expect(launchPlan({ ...base, continue: true, projects: one })).toEqual({ kind: "open", projectId: "a", then: "continue" })
    expect(launchPlan({ ...base, resume: true, projects: one })).toEqual({ kind: "open", projectId: "a", then: "resume" })
  })
})
