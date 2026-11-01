import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProjectRow, Push } from "../src/shared/types"
import { closeDb, getDb, openDb } from "../src/main/db"
import { EventLog } from "../src/main/events/log"
import { deleteProject, ProjectStore, slug, type NewProject } from "../src/main/projects"
import { SandboxRegistry, SpecialistBoxes } from "../src/main/sandbox/specialistbox"
import { detectTarget, isDotNet, kindOf, localPath } from "../src/main/target"

/* specs/projects R1, R3: projects, their targets and folders, and the tasks from before them. */

let base = ""
let data = ""
let pushed: Push[] = []
let store: ProjectStore
let log: EventLog

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-proj-"))
  data = join(base, "data")
  openDb(join(data, "hfr.db"))
  pushed = []
  log = new EventLog(data)
  store = new ProjectStore(data, (p) => pushed.push(p))
})
afterEach(() => closeDb())

const input = (target: string, o: Partial<NewProject> = {}): NewProject => ({
  name: "Game client",
  goal: "understand",
  target,
  provider: "openrouter",
  model: "deepseek/deepseek-v4.1-flash-1017",
  orchestratorEffort: "default",
  specialistEffort: "high",
  ...o,
})

/** A PE image whose optional header declares a CLR runtime header, or none. */
function pe(clr: boolean): Buffer {
  const b = Buffer.alloc(0x200)
  b.write("MZ", 0, "latin1")
  b.writeUInt32LE(0x80, 0x3c)
  b.write("PE\0\0", 0x80, "latin1")
  const opt = 0x80 + 24
  b.writeUInt16LE(0x10b, opt)
  if (clr) {
    b.writeUInt32LE(0x2008, opt + 96 + 14 * 8)
    b.writeUInt32LE(0x48, opt + 96 + 14 * 8 + 4)
  }
  return b
}

describe("a target's kind (R1.4)", () => {
  it("tells kinds from extensions and first bytes", () => {
    expect(kindOf("game.apk", Buffer.from("PK\x03\x04"))).toBe("android")
    expect(kindOf("libil2cpp.so", Buffer.from("\x7fELF\x02\x01", "latin1"))).toBe("elf")
    expect(kindOf("app.exe", pe(false))).toBe("pe")
    expect(kindOf("Assembly-CSharp.dll", pe(true))).toBe("dotnet")
    expect(isDotNet(pe(true))).toBe(true)
    expect(isDotNet(Buffer.from("MZ"))).toBe(false)
    expect(kindOf("tool", Buffer.from("cffaedfe", "hex"))).toBe("macho")
    expect(kindOf("app.asar", Buffer.alloc(4))).toBe("electron")
    expect(kindOf("bundle.js", Buffer.from("const a"))).toBe("javascript")
    expect(kindOf("data.zip", Buffer.from("PK\x03\x04"))).toBe("archive")
    expect(kindOf("flash.bin", Buffer.alloc(8))).toBe("firmware")
    expect(kindOf("notes", Buffer.from("hello"))).toBe("file")
  })

  it("reads a file's head and a folder's packages, with the engines for each", () => {
    const apk = join(base, "game.apk")
    writeFileSync(apk, Buffer.from("PK\x03\x04rest"))
    expect(detectTarget(apk)).toMatchObject({
      kind: "android",
      isFile: true,
      size: 8,
      label: "Android package",
      engines: expect.arrayContaining(["JADX", "Apktool"]),
    })
    mkdirSync(join(base, "electron", "resources"), { recursive: true })
    writeFileSync(join(base, "electron", "resources", "app.asar"), "x")
    expect(detectTarget(join(base, "electron"))).toMatchObject({ kind: "electron", isFile: false })
    mkdirSync(join(base, "plain"))
    expect(detectTarget(join(base, "plain")).kind).toBe("folder")
    expect(() => detectTarget(join(base, "missing"))).toThrow()
  })
})

describe("creating a project (R1.1–R1.3, R1.7)", () => {
  it("keeps a file target as a copy in the project's own folder under the app's data", async () => {
    const apk = join(base, "Downloads", "game.apk")
    mkdirSync(join(base, "Downloads"))
    writeFileSync(apk, "PK\x03\x04apk")
    writeFileSync(join(base, "Downloads", "sibling.txt"), "private")
    const p = await store.create(input(apk))
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.folder).toBe(join(data, "projects", p.id))
    expect(p).toMatchObject({ name: "Game client", goal: "understand", targetKind: "android", targetPath: apk, ownsFolder: true, specialistEffort: "high" })
    // the tasks mount the project's copy, never the file's siblings
    expect(p.sourceRoot).toBe(join(p.folder, "target"))
    expect(readFileSync(join(p.sourceRoot, "game.apk"), "utf8")).toBe("PK\x03\x04apk")
    expect(existsSync(join(p.sourceRoot, "sibling.txt"))).toBe(false)
    expect(pushed).toContainEqual({ type: "project", project: p })
    expect(store.list().map((x) => x.id)).toEqual([p.id])
  })

  it("reads a folder target in place, and puts the project under a folder the user chose", async () => {
    const src = join(base, "src")
    mkdirSync(src)
    const parent = join(base, "Documents")
    mkdirSync(parent)
    const p = await store.create(input(src, { name: "My Tool!", parentFolder: parent }))
    expect(p.sourceRoot).toBe(src)
    expect(p.folder).toBe(join(parent, `my-tool-${p.id}`))
    expect(existsSync(p.folder)).toBe(true)
    expect(slug("  Ação 2 ")).toBe("acao-2")
  })

  it("refuses an unreadable target or an unwritable folder, keeping nothing", async () => {
    await expect(store.create(input(join(base, "nope")))).rejects.toThrow(/target cannot be read/)
    writeFileSync(join(base, "file-not-folder"), "x")
    const src = join(base, "src2")
    mkdirSync(src)
    await expect(store.create(input(src, { parentFolder: join(base, "file-not-folder") }))).rejects.toThrow(/folder cannot be written/)
    await expect(store.create(input(src, { name: "  " }))).rejects.toThrow(/Name the project/)
    expect(store.list()).toEqual([])
  })

  it("takes only absolute local paths from the renderer, and never the app's own data", async () => {
    expect(() => localPath("relative/game.apk")).toThrow(/not an absolute path/)
    expect(() => localPath(String.raw`\\host\share\game.apk`)).toThrow(/network or device path/)
    expect(() => localPath("//host/share/game.apk")).toThrow(/network or device path/)
    expect(() => detectTarget("game.apk")).toThrow(/not an absolute path/)
    const src = join(base, "src4")
    mkdirSync(src)
    await expect(store.create(input(src, { parentFolder: "projects" }))).rejects.toThrow(/not an absolute path/)
    await expect(store.create(input(data))).rejects.toThrow(/app's data folder/)
    mkdirSync(join(data, "inner"))
    await expect(store.create(input(join(data, "inner")))).rejects.toThrow(/app's data folder/)
    expect(store.list()).toEqual([])
  })

  it("removes the folder it made when the project cannot be recorded (R1.7)", async () => {
    const target = join(base, "Downloads2", "game.apk")
    mkdirSync(join(base, "Downloads2"))
    writeFileSync(target, "PK\x03\x04")
    getDb().exec("DROP TABLE projects")
    await expect(store.create(input(target))).rejects.toThrow(/could not be created/)
    expect(readdirSync(join(data, "projects"))).toEqual([])
  })
})

describe("the tasks from before projects (R3.3)", () => {
  it("gives them one project per source folder, keeping their folders where they are", () => {
    const a1 = log.createTask({ request: "r1", sourceRoot: "C:/work/game", model: "m" })
    const a2 = log.createTask({ request: "r2", sourceRoot: "C:/work/game", model: "m" })
    const b = log.createTask({ request: "r3", sourceRoot: "C:/work/tool", model: "m" })
    getDb().prepare("INSERT INTO sandboxes (id, project_id, created_by, limits, created_at) VALUES ('s1', NULL, ?, '{}', 0)").run(a1.id)
    expect(store.adopt({ provider: "openrouter", model: "m", orchestratorEffort: "default", specialistEffort: "default" })).toBe(2)
    const projects = store.list()
    expect(projects.map((p) => p.name).sort()).toEqual(["game", "tool"])
    const game = projects.find((p) => p.name === "game")!
    expect(game).toMatchObject({ goal: "understand", folder: data, ownsFolder: false, sourceRoot: "C:/work/game" })
    expect(log.getTask(a1.id).projectId).toBe(game.id)
    expect(log.getTask(a2.id).projectId).toBe(game.id)
    expect(log.getTask(b.id).projectId).not.toBe(game.id)
    // their folders stay at <userData>/tasks/<id>
    expect(log.taskDir(a1.id)).toBe(join(data, "tasks", a1.id))
    expect((getDb().prepare("SELECT project_id FROM sandboxes WHERE id = 's1'").get() as { project_id: string }).project_id).toBe(game.id)
    // and a second start finds nothing left to adopt
    expect(store.adopt({ provider: "openrouter", model: "m", orchestratorEffort: "default", specialistEffort: "default" })).toBe(0)
  })

  it("keeps a sandbox from before projects reachable where its task left it", () => {
    const t = log.createTask({ request: "r", sourceRoot: "C:/work/game", model: "m" })
    getDb().prepare("INSERT INTO sandboxes (id, project_id, created_by, limits, created_at) VALUES ('s-old', NULL, ?, '{}', 0)").run(t.id)
    mkdirSync(join(data, "tasks", t.id, "workspace", "s-old"), { recursive: true })
    store.adopt({ provider: "openrouter", model: "m", orchestratorEffort: "default", specialistEffort: "default" })
    const game = store.list()[0]
    const exec = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) as never
    const boxes = new SpecialistBoxes({ exec, log, dir: game.folder, sourceRoot: game.sourceRoot, projectId: game.id })
    expect(boxes.ids()).toEqual(["s-old"])
    expect(boxes.usable("s-old").ws.workspace).toBe(join(data, "tasks", t.id, "workspace", "s-old"))
  })

  it("keeps a new project's tasks under its folder (R2.2)", async () => {
    const src = join(base, "src3")
    mkdirSync(src)
    const p = await store.create(input(src))
    const t = log.createTask({ request: "r", sourceRoot: p.sourceRoot, model: p.model, projectId: p.id })
    expect(log.taskDir(t.id)).toBe(join(p.folder, "tasks", t.id))
    expect(log.projectTasks(p.id).map((x) => x.id)).toEqual([t.id])
  })
})

describe("deleting a project (R3.1, R3.2)", () => {
  it("is refused while a task runs, and otherwise removes its tasks, sandboxes, folder and record", async () => {
    const src = join(base, "src4")
    mkdirSync(src)
    const p = await store.create(input(src))
    const t = log.createTask({ request: "r", sourceRoot: p.sourceRoot, model: p.model, projectId: p.id })
    const removed: string[] = []
    const sandboxes: ProjectRow[] = []
    const d = {
      store,
      log,
      runner: { remove: async (id: string) => void removed.push(id) },
      sandboxes: { remove: async (x: ProjectRow) => void sandboxes.push(x) },
    }
    log.updateTask(t.id, { state: "running" })
    await expect(deleteProject(d, p.id)).rejects.toThrow(/cancel it before deleting the project/)
    log.updateTask(t.id, { state: "done" })
    writeFileSync(join(p.folder, "left.txt"), "x")
    await deleteProject(d, p.id)
    expect(removed).toEqual([t.id])
    expect(sandboxes.map((x) => x.id)).toEqual([p.id])
    expect(existsSync(p.folder)).toBe(false)
    expect(() => store.get(p.id)).toThrow(/No project/)
    expect(pushed).toContainEqual({ type: "projectDeleted", id: p.id })
    // the target folder the user pointed at is never touched
    expect(existsSync(src)).toBe(true)
  })

  it("keeps a folder the app did not create", async () => {
    const t = log.createTask({ request: "r", sourceRoot: "C:/old", model: "m" })
    log.updateTask(t.id, { state: "done" })
    store.adopt({ provider: "openrouter", model: "m", orchestratorEffort: "default", specialistEffort: "default" })
    const old = store.list()[0]
    await deleteProject({ store, log, runner: { remove: async () => undefined }, sandboxes: { remove: async () => undefined } }, old.id)
    expect(existsSync(data)).toBe(true)
  })
})

describe("one set of sandboxes per project (R2.3)", () => {
  it("is shared by the project's open tasks, stopped when the last one closes, and made again after", async () => {
    const made: { id: string; stopped: number; removed: number }[] = []
    const registry = new SandboxRegistry((p) => {
      const m = { id: p.id, stopped: 0, removed: 0 }
      made.push(m)
      return { stopAll: async () => void m.stopped++, removeAll: async () => void m.removed++ } as unknown as SpecialistBoxes
    })
    const project = { id: "p", folder: "f", sourceRoot: "s" }
    const a = registry.acquire(project)
    const b = registry.acquire(project)
    expect(a.boxes).toBe(b.boxes)
    await a.release()
    await a.release()
    expect(made[0].stopped).toBe(0)
    await b.release()
    expect(made[0].stopped).toBe(1)
    const c = registry.acquire(project)
    expect(made).toHaveLength(2)
    await registry.remove(project)
    expect(made[1].removed).toBe(1)
    await c.release()
    expect(made[1].stopped).toBe(0)
    // a project with no open task gets an instance of its own to be removed
    await registry.remove({ id: "q", folder: "f", sourceRoot: "s" })
    expect(made.at(-1)).toMatchObject({ id: "q", removed: 1 })
  })

  it("makes a task that opens while the last one's stop is in flight wait for it", async () => {
    let finish = () => undefined as void
    const afters: (Promise<void> | undefined)[] = []
    const registry = new SandboxRegistry((_p, after) => {
      afters.push(after)
      return { stopAll: () => new Promise<void>((r) => (finish = r)), removeAll: async () => undefined } as unknown as SpecialistBoxes
    })
    const project = { id: "p", folder: "f", sourceRoot: "s" }
    const stopping = registry.acquire(project).release()
    registry.acquire(project)
    expect(afters[0]).toBeUndefined()
    let settled = false
    void afters[1]!.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await stopping
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it("makes no Docker call before an earlier instance finished stopping", async () => {
    const calls: string[][] = []
    let finish = () => undefined as void
    const after = new Promise<void>((r) => (finish = r))
    const src = join(base, "src5")
    mkdirSync(src)
    const p = await store.create(input(src))
    const t = log.createTask({ request: "r", sourceRoot: src, model: "m", projectId: p.id })
    const exec = async (args: string[]) => (calls.push(args), { code: 0, stdout: Buffer.from("cid"), stderr: "" }) as never
    const boxes = new SpecialistBoxes({ exec, log, dir: p.folder, sourceRoot: src, projectId: p.id, after })
    const creating = boxes.create({}, t.id).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual([])
    finish()
    await creating
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe("a project being deleted", () => {
  it("refuses a second delete while the first runs", async () => {
    const src = join(base, "src6")
    mkdirSync(src)
    const p = await store.create(input(src))
    let go = () => undefined as void
    const slow = new Promise<void>((r) => (go = r))
    const d = { store, log, runner: { remove: async () => undefined }, sandboxes: { remove: () => slow } }
    const first = deleteProject(d, p.id)
    expect(store.deleting.has(p.id)).toBe(true)
    await expect(deleteProject(d, p.id)).rejects.toThrow(/already being deleted/)
    go()
    await first
    expect(store.deleting.has(p.id)).toBe(false)
  })
})
