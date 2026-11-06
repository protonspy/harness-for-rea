import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { Push } from "../src/shared/types"
import { initKey, moveKeys, readKey, useKeyStore, type KeyStore } from "../src/main/credentials"
import { closeDb, exclusive, getDb, openDb, SCHEMA_VERSION, SchemaTooNew } from "../src/main/db"
import { EventLog, eventRow, patchRow, stepRow } from "../src/main/events/log"
import { keyringStore, type KeyEntry } from "../src/main/keys"
import { ProcessRegistry, STALE_MS } from "../src/main/processes"
import { BASE_IMAGE, CLAUDE_CODE_VERSION, SPECIALIST_IMAGE, type Exec } from "../src/main/sandbox/docker"
import { LoginService, SandboxService, type OnceGuard } from "../src/main/status"
import { ChangeWatcher } from "../src/main/watch"

/* specs/shared-data-folder: several processes on one data folder. */

const tmp = () => mkdtempSync(join(tmpdir(), "hfr-shared-"))
afterEach(() => closeDb())

describe("processes (R2.1)", () => {
  it("knows a process by pid and start time: alive while its pid runs and its heartbeat is fresh", () => {
    openDb(":memory:")
    let now = 1_000_000
    const alive = new Set([1001, 2002])
    const me = new ProcessRegistry(
      "desktop",
      "1.0.0",
      () => now,
      (pid) => alive.has(pid),
      1001,
      500,
    )
    const other = new ProcessRegistry(
      "tui",
      "1.0.0",
      () => now,
      (pid) => alive.has(pid),
      2002,
      600,
    )
    me.start()
    other.start()
    expect(me.key).toBe("1001:500")
    expect(me.isLive(me.key)).toBe(true)
    expect(me.isLive(other.key)).toBe(true)
    expect(me.isLive(null)).toBe(false)
    expect(me.isLive("2002:999")).toBe(false)
    // a heartbeat gone stale, though the pid was reused by something else
    now += STALE_MS + 1
    expect(me.isLive(other.key)).toBe(false)
    other.beat()
    expect(me.isLive(other.key)).toBe(true)
    alive.delete(2002)
    expect(me.isLive(other.key)).toBe(false)
    me.prune()
    expect((getDb().prepare("SELECT key FROM processes").all() as { key: string }[]).map((r) => r.key)).toEqual([me.key])
    me.stop()
    other.stop()
  })

  it("records a live process again at its next beat after another app pruned it while its heartbeat was stale", () => {
    openDb(":memory:")
    let now = 1_000_000
    const me = new ProcessRegistry(
      "desktop",
      "1.0.0",
      () => now,
      () => true,
      1001,
      500,
    )
    const sleeper = new ProcessRegistry(
      "tui",
      "1.0.0",
      () => now,
      () => true,
      2002,
      600,
    )
    me.start()
    sleeper.start()
    // the machine slept past the stale window; the other app pruned it at its start
    now += STALE_MS + 1
    me.beat()
    me.prune()
    expect(me.isLive(sleeper.key)).toBe(false)
    sleeper.beat()
    expect(me.isLive(sleeper.key)).toBe(true)
    me.stop()
    sleeper.stop()
  })
})

describe("recovery (R2.2)", () => {
  it("interrupts only the tasks and steps of a process that is gone", () => {
    openDb(":memory:")
    const log = new EventLog(tmp())
    log.owner = "live:1"
    const mine = log.createTask({ request: "a", sourceRoot: "C:/a", model: "m" })
    log.updateTask(mine.id, { state: "running" })
    log.owner = "gone:1"
    const theirs = log.createTask({ request: "b", sourceRoot: "C:/b", model: "m" })
    log.updateTask(theirs.id, { state: "running" })
    log.owner = null
    const legacy = log.createTask({ request: "c", sourceRoot: "C:/c", model: "m" })
    log.updateTask(legacy.id, { state: "waiting" })
    const s1 = log.addStep({ taskId: mine.id, kind: "delegation", title: "x", agent: "specialist", state: "running" })
    const s2 = log.addStep({ taskId: theirs.id, kind: "delegation", title: "y", agent: "specialist", state: "running" })

    expect(log.taskOwner(mine.id)).toBe("live:1")
    // a container named for a task this database does not hold is another data folder's (R2.3)
    expect(log.hasTask(mine.id)).toBe(true)
    expect(log.hasTask("99999999-9999-4999-8999-999999999999")).toBe(false)
    expect(log.recover((owner) => owner === "live:1")).toBe(2)
    expect(log.getTask(mine.id).state).toBe("running")
    expect(log.getTask(theirs.id).state).toBe("interrupted")
    expect(log.getTask(legacy.id).state).toBe("interrupted")
    expect(log.steps(mine.id).find((s) => s.id === s1.id)?.state).toBe("running")
    expect(log.steps(theirs.id).find((s) => s.id === s2.id)?.state).toBe("interrupted")
  })
})

describe("the database (R3)", () => {
  it("waits for another writer, migrates once, and records which app did", () => {
    const file = join(tmp(), "hfr.db")
    const d = openDb(file, { app: "tui", version: "0.2.0" })
    expect((d.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000)
    expect((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(JSON.parse((d.prepare("SELECT value FROM settings WHERE key = 'schema.by'").get() as { value: string }).value)).toMatchObject({
      app: "tui",
      version: "0.2.0",
    })
    closeDb()
    // a second app finds it done and records nothing
    openDb(file, { app: "desktop", version: "0.2.0" })
    expect(JSON.parse((getDb().prepare("SELECT value FROM settings WHERE key = 'schema.by'").get() as { value: string }).value).app).toBe("tui")
  })

  it("refuses a database a newer app migrated, naming it, and writes nothing", () => {
    const file = join(tmp(), "hfr.db")
    openDb(file, { app: "desktop", version: "0.2.0" })
    getDb().exec(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`)
    getDb()
      .prepare("UPDATE settings SET value = ? WHERE key = 'schema.by'")
      .run(JSON.stringify({ app: "desktop", version: "9.1.0" }))
    closeDb()
    expect(() => openDb(file, { app: "tui", version: "0.2.0" })).toThrow(SchemaTooNew)
    expect(() => openDb(file, { app: "tui", version: "0.2.0" })).toThrow("upgraded by Harness for REA 9.1.0 (the desktop app)")
    const raw = new DatabaseSync(file)
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 3)
    raw.close()
  })

  it("rolls back an exclusive write that fails", () => {
    openDb(":memory:")
    expect(() =>
      exclusive(() => {
        getDb().prepare("INSERT INTO settings (key, value) VALUES ('x', '1')").run()
        throw new Error("no")
      }),
    ).toThrow("no")
    expect(getDb().prepare("SELECT 1 FROM settings WHERE key = 'x'").get()).toBeUndefined()
  })
})

describe("done once per machine (R4.2, R4.3)", () => {
  const docker = () => {
    const calls: string[] = []
    let ready = false
    const exec: Exec = async (args) => {
      calls.push(args.join(" "))
      if (args[0] === "version") return { code: 0, stdout: "29\n", stderr: "" }
      if (args[0] === "build") {
        ready = true
        return { code: 0, stdout: "", stderr: "" }
      }
      if (args.join(" ").startsWith(`image inspect ${SPECIALIST_IMAGE}`))
        return ready ? { code: 0, stdout: `${CLAUDE_CODE_VERSION} ${BASE_IMAGE}`, stderr: "" } : { code: 1, stdout: "", stderr: "No such image" }
      return { code: 0, stdout: "", stderr: "" }
    }
    return { exec, calls, finish: () => (ready = true) }
  }

  it("shows another app's image build as running there, builds nothing, and reads the images again once it is done", async () => {
    const d = docker()
    let held = true
    const guard: OnceGuard = { take: () => (held ? { heldBy: "a terminal UI (process 7)" } : () => undefined) }
    const s = new SandboxService(d.exec, "/sandbox", () => undefined, guard, 5)
    const first = await s.status()
    expect(first.building).toBe(true)
    expect(first.buildLog).toContain("being prepared by a terminal UI (process 7)")
    const { done } = s.build()
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false)
    d.finish()
    held = false
    await new Promise((r) => setTimeout(r, 30))
    const after = await s.status()
    expect(after.building).toBe(false)
    expect(after.images).toBe(true)
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false)
    void done
  })

  it("holds the build's guard while it builds, and releases it after", async () => {
    const d = docker()
    let released = 0
    const s = new SandboxService(d.exec, "/sandbox", () => undefined, { take: () => () => void released++ })
    await s.build().done
    expect(d.calls.filter((c) => c.startsWith("build"))).toHaveLength(1)
    expect(released).toBe(1)
  })

  it("refuses a second sign-in while another app signs Claude in, naming it", () => {
    const login = new LoginService(
      () => {
        throw new Error("never started")
      },
      () => undefined,
      { take: () => ({ heldBy: "the desktop app (process 9)" }) },
    )
    expect(() => login.start()).toThrow("Claude is being signed in from the desktop app (process 9)")
  })
})

describe("keys (R5.1, R5.2)", () => {
  const memory = (init: Record<string, string> = {}): KeyStore & { slots: Map<string, string> } => {
    const slots = new Map(Object.entries(init))
    return {
      slots,
      available: () => true,
      read: async (s) => slots.get(s) ?? null,
      write: async (s, k) => void (k === null ? slots.delete(s) : slots.set(s, k)),
    }
  }

  it("keeps each key as the UTF-8 bytes of one keychain entry per slot", async () => {
    const entries = new Map<string, number[]>()
    const make = (service: string, name: string): KeyEntry => ({
      getSecret: async () => entries.get(`${service}/${name}`) ?? null,
      setSecret: async (b) => void entries.set(`${service}/${name}`, [...b]),
      deleteCredential: async () => entries.delete(`${service}/${name}`),
    })
    const store = keyringStore("hfr-test", make)
    await store.write("openrouter.key", "sk-or-ü-1234")
    expect(Buffer.from(entries.get("hfr-test/openrouter.key")!).toString("utf8")).toBe("sk-or-ü-1234")
    expect(await store.read("openrouter.key")).toBe("sk-or-ü-1234")
    await store.write("openrouter.key", null)
    expect(await store.read("openrouter.key")).toBeNull()
    expect(keyringStore("x", null).available()).toBe(false)
  })

  it("chunks large secrets with generational isolation and rollback on failure (D3)", async () => {
    const entries = new Map<string, number[]>()
    let failOnChunkName: string | null = null

    const make = (service: string, name: string): KeyEntry => ({
      getSecret: async () => entries.get(`${service}/${name}`) ?? null,
      setSecret: async (b) => {
        if (failOnChunkName && name.includes(failOnChunkName)) {
          throw new Error(`Simulated write failure on ${name}`)
        }
        entries.set(`${service}/${name}`, [...b])
      },
      deleteCredential: async () => entries.delete(`${service}/${name}`),
    })

    const store = keyringStore("hfr-test", make)
    const initial4500A = "A".repeat(4500)
    await store.write("chatgpt.key", initial4500A)

    // Verify manifest points to 3 chunks of generation
    const rootVal = Buffer.from(entries.get("hfr-test/chatgpt.key")!).toString("utf8")
    expect(rootVal).toMatch(/^__HFR_CHUNKED__:[a-z0-9]+:3$/)
    expect(await store.read("chatgpt.key")).toBe(initial4500A)

    // Simulate failure during update: writing 4500 B fails on chunk #1
    failOnChunkName = "#1"
    const next4500B = "B".repeat(4500)
    await expect(store.write("chatgpt.key", next4500B)).rejects.toThrow("Simulated write failure")
    failOnChunkName = null

    // Crucial D3 invariant: previous credential is preserved intact; failed generation chunks rolled back
    expect(await store.read("chatgpt.key")).toBe(initial4500A)

    // Reduction in size: write 2200 C (2 chunks)
    const reduced2200C = "C".repeat(2200)
    await store.write("chatgpt.key", reduced2200C)
    expect(await store.read("chatgpt.key")).toBe(reduced2200C)

    // Verify old generation chunks were completely removed
    const allKeys = Array.from(entries.keys())
    const chunkKeys = allKeys.filter((k) => k.startsWith("hfr-test/chatgpt.key#"))
    expect(chunkKeys.length).toBe(2)

    // Logout / write null: all chunks and root must be cleaned
    await store.write("chatgpt.key", null)
    expect(await store.read("chatgpt.key")).toBeNull()
    const remainingKeys = Array.from(entries.keys()).filter((k) => k.startsWith("hfr-test/chatgpt.key"))
    expect(remainingKeys.length).toBe(0)
  })

  it("respects byte limits and guarantees Unicode multi-byte integrity across chunk boundaries (D4)", async () => {
    const entries = new Map<string, number[]>()
    const maxPlatformBytes = 2560

    const make = (service: string, name: string): KeyEntry => ({
      getSecret: async () => entries.get(`${service}/${name}`) ?? null,
      setSecret: async (b) => {
        if (b.byteLength > maxPlatformBytes) {
          throw new Error(`Value of 'secret' is longer than the platform limit of ${maxPlatformBytes} chars/bytes`)
        }
        entries.set(`${service}/${name}`, [...b])
      },
      deleteCredential: async () => entries.delete(`${service}/${name}`),
    })

    const store = keyringStore("hfr-test", make)

    // 1500 'é' characters = 3000 UTF-8 bytes (must be chunked; each chunk <= 2000 bytes)
    const multiByte3000 = "é".repeat(1500)
    await store.write("chatgpt.key", multiByte3000)
    expect(await store.read("chatgpt.key")).toBe(multiByte3000)

    // Verify every stored entry is strictly below platform byte limit
    for (const [, v] of entries.entries()) {
      expect(v.length).toBeLessThanOrEqual(2000)
    }

    // Boundary spanning: 1999 ASCII chars + 4-byte emoji 🚀 (U+1F680) + 100 ASCII chars
    const spanningSecret = "X".repeat(1999) + "🚀" + "Y".repeat(100)
    await store.write("chatgpt.key", spanningSecret)
    const retrieved = await store.read("chatgpt.key")
    expect(retrieved).toBe(spanningSecret)
    expect(retrieved?.includes("🚀")).toBe(true)
  })

  it("retries reading across generation rotation when chunks are pruned by a concurrent writer (E1)", async () => {
    const entries = new Map<string, number[]>()
    let pauseReadAfterRoot = false
    const signal = { resume: null as (() => void) | null }

    const make = (service: string, name: string): KeyEntry => ({
      getSecret: async () => {
        if (name === "chatgpt.key" && pauseReadAfterRoot) {
          pauseReadAfterRoot = false
          await new Promise<void>((r) => {
            signal.resume = r
          })
        }
        return entries.get(`${service}/${name}`) ?? null
      },
      setSecret: async (b) => void entries.set(`${service}/${name}`, [...b]),
      deleteCredential: async () => entries.delete(`${service}/${name}`),
    })

    const storeA = keyringStore("hfr-test", make)
    const storeB = keyringStore("hfr-test", make)

    const g0Data = "A".repeat(4500)
    await storeA.write("chatgpt.key", g0Data)

    pauseReadAfterRoot = true
    const readPromise = storeA.read("chatgpt.key")

    while (!signal.resume) {
      await new Promise((r) => setTimeout(r, 5))
    }

    const g1Data = "B".repeat(4500)
    await storeB.write("chatgpt.key", g1Data)

    signal.resume!()
    const result = await readPromise
    expect(result).toBe(g1Data)
  })

  it("coordinates concurrent writers and prevents orphaned generation chunks on logout (E2)", async () => {
    const entries = new Map<string, number[]>()
    const make = (service: string, name: string): KeyEntry => ({
      getSecret: async () => entries.get(`${service}/${name}`) ?? null,
      setSecret: async (b) => {
        await new Promise((r) => setTimeout(r, 2))
        entries.set(`${service}/${name}`, [...b])
      },
      deleteCredential: async () => {
        await new Promise((r) => setTimeout(r, 1))
        return entries.delete(`${service}/${name}`)
      },
    })

    const store1 = keyringStore("hfr-test", make)
    const store2 = keyringStore("hfr-test", make)

    const initial4500A = "A".repeat(4500)
    await store1.write("chatgpt.key", initial4500A)
    expect(await store1.read("chatgpt.key")).toBe(initial4500A)

    const next4500B = "B".repeat(4500)
    const next4500C = "C".repeat(4500)
    await Promise.all([store1.write("chatgpt.key", next4500B), store2.write("chatgpt.key", next4500C)])

    const finalVal = await store1.read("chatgpt.key")
    expect(finalVal === next4500B || finalVal === next4500C).toBe(true)

    await store1.write("chatgpt.key", null)

    const remaining = Array.from(entries.keys()).filter((k) => k.startsWith("hfr-test/chatgpt.key"))
    expect(remaining).toEqual([])
    expect(await store1.read("chatgpt.key")).toBeNull()
  })

  it("moves the keys of a former store into the shared one, keeping one already there, and removes them", async () => {
    const former = memory({ "openrouter.key": "sk-old-openrouter", "deepseek.key": "sk-old-deepseek" })
    const shared = memory({ "deepseek.key": "sk-shared-deepseek" })
    expect(await moveKeys(former, shared)).toBe(2)
    expect(former.slots.size).toBe(0)
    expect(shared.slots.get("openrouter.key")).toBe("sk-old-openrouter")
    expect(shared.slots.get("deepseek.key")).toBe("sk-shared-deepseek")
    useKeyStore(shared)
    await initKey()
    expect(readKey("openrouter")).toBe("sk-old-openrouter")
  })
})

describe("changes made by another process (R5.3)", () => {
  it("pushes the tasks, steps, events, patches and projects another connection wrote, and deletions, once each", () => {
    const file = join(tmp(), "hfr.db")
    openDb(file)
    const pushes: Push[] = []
    const log = new EventLog(tmp())
    let holders = ""
    let keys = 0
    const w = new ChangeWatcher(
      {
        push: (p) => pushes.push(p),
        task: (id) => log.getTask(id),
        step: stepRow,
        event: eventRow,
        patch: patchRow,
        project: (id) => ({ id, name: "p", updatedAt: 0 }) as never,
        holders: () => holders,
        keysChanged: () => void keys++,
      },
      60_000,
    )
    w.start()
    expect(w.tick()).toBe(0)

    // another app, its own connection
    const other = openOther(file)
    const id = "11111111-1111-4111-8111-111111111111"
    other.prepare("INSERT INTO tasks (id, request, source_root, model, state, created_at, updated_at) VALUES (?, 'r', 'C:/x', 'm', 'running', 5, 5)").run(id)
    other.prepare("INSERT INTO events (task_id, agent, at, kind, summary, payload) VALUES (?, 'app', 5, 'task.started', 's', '{}')").run(id)
    other
      .prepare(
        "INSERT INTO steps (id, task_id, ord, kind, title, agent, state, created_at, updated_at) VALUES ('s1', ?, 0, 'plan', 't', 'orchestrator', 'running', 5, 5)",
      )
      .run(id)
    other.prepare("INSERT INTO patches (id, task_id, step_id, state, files, diff, created_at) VALUES ('p1', ?, 's1', 'pending', '[]', '', 5)").run(id)
    other.prepare("INSERT INTO settings (key, value) VALUES ('keys.rev', '1')").run()
    expect(w.tick()).toBe(4)
    expect(pushes.map((p) => p.type).sort()).toEqual(["event", "patch", "step", "task"])
    expect(keys).toBe(1)
    // nothing new: nothing pushed again
    expect(w.tick()).toBe(0)

    other.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    expect(w.tick()).toBe(1)
    expect(pushes.at(-1)).toEqual({ type: "taskDeleted", id })

    // a project taken by another app, seen through the locks rather than the database
    other
      .prepare(
        `INSERT INTO projects (id, name, goal, target_path, target_kind, source_root, folder, provider, model, orchestrator_effort, specialist_effort, created_at, updated_at)
       VALUES ('pr', 'n', 'understand', 'C:/t', 'folder', 'C:/t', 'C:/f', 'openrouter', 'm', 'medium', 'medium', 6, 6)`,
      )
      .run()
    expect(w.tick()).toBe(1)
    holders = "project-pr=1:1"
    expect(w.tick()).toBe(1)
    expect(pushes.at(-1)?.type).toBe("project")
    other.close()
    w.stop()
  })

  it("reads a change again when the diff that saw it failed part-way", () => {
    const file = join(tmp(), "hfr.db")
    openDb(file)
    const pushes: Push[] = []
    const log = new EventLog(tmp())
    let failOnce = true
    const w = new ChangeWatcher(
      {
        push: (p) => pushes.push(p),
        task: (id) => {
          if (failOnce) {
            failOnce = false
            throw new Error("deleted between two reads")
          }
          return log.getTask(id)
        },
        step: stepRow,
        event: eventRow,
        patch: patchRow,
        project: () => ({}) as never,
        holders: () => "",
        keysChanged: () => undefined,
      },
      60_000,
    )
    w.start()
    const other = openOther(file)
    other.prepare("INSERT INTO tasks (id, request, source_root, model, state, created_at, updated_at) VALUES ('t1', 'r', 'C:/x', 'm', 'running', 5, 5)").run()
    expect(w.tick()).toBe(0)
    expect(w.tick()).toBe(1)
    expect(pushes[0]).toMatchObject({ type: "task" })
    other.close()
    w.stop()
  })

  it("does not push what this process pushed itself", () => {
    const file = join(tmp(), "hfr.db")
    openDb(file)
    const pushes: Push[] = []
    const log = new EventLog(tmp())
    const w = new ChangeWatcher({
      push: (p) => pushes.push(p),
      task: (id) => log.getTask(id),
      step: stepRow,
      event: eventRow,
      patch: patchRow,
      project: () => ({}) as never,
      holders: () => "",
      keysChanged: () => undefined,
    })
    log.setPush((p) => w.saw(p))
    w.start()
    const t = log.createTask({ request: "r", sourceRoot: "C:/x", model: "m" })
    log.append({ taskId: t.id, agent: "app", kind: "x", summary: "s" })
    // another connection commits something unrelated, so the version moves
    const other = openOther(file)
    other.prepare("INSERT INTO settings (key, value) VALUES ('unrelated', '1')").run()
    expect(w.tick()).toBe(0)
    other.close()
    w.stop()
  })
})

function openOther(file: string): DatabaseSync {
  const d = new DatabaseSync(file)
  d.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
  return d
}
