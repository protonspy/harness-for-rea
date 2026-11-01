import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { Command, emptyCheckpoint, END, interrupt, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { closeDb, getDb, openDb } from "../src/main/db"
import { SqliteSaver } from "../src/main/orchestrator/checkpoint"

/* specs/task-persistence R1: a conversation outlives the process that held it. */

let file = ""
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "hfr-ckpt-")), "hfr.db")
  openDb(file)
})
afterEach(() => closeDb())

/** A graph that answers, then asks for approval before it answers again: a checkpoint and a pending interrupt. */
function graph(saver: SqliteSaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode("answer", (s) => ({ messages: [new AIMessage(`echo ${s.messages.length}`)] }))
    .addNode("approve", () => {
      const ok = interrupt("approve?")
      return { messages: [new AIMessage(`approved ${String(ok)}`)] }
    })
    .addEdge(START, "answer")
    .addEdge("answer", "approve")
    .addEdge("approve", END)
    .compile({ checkpointer: saver })
}

const config = { configurable: { thread_id: "task-1" } }

describe("the conversation in the database (R1.1, R1.2)", () => {
  it("is read back by a fresh saver after the app restarts, with its pending interrupt", async () => {
    await graph(new SqliteSaver()).invoke({ messages: [new HumanMessage("hi")] }, config)
    // the app quits and starts again: a new database handle, a new saver with empty maps
    closeDb()
    openDb(file)
    const g = graph(new SqliteSaver())
    const state = await g.getState(config)
    expect(state.values.messages.map((m: { content: unknown }) => m.content)).toEqual(["hi", "echo 1"])
    expect(state.next).toEqual(["approve"])
    // and the interrupted step resumes where it stopped
    const done = await g.invoke(new Command({ resume: true }), config)
    expect(done.messages.at(-1)!.content).toBe("approved true")
  })

  it("continues a thread with a new message after a restart", async () => {
    const first = graph(new SqliteSaver())
    await first.invoke({ messages: [new HumanMessage("hi")] }, config)
    await first.invoke(new Command({ resume: "no" }), config)
    closeDb()
    openDb(file)
    const g = graph(new SqliteSaver())
    await g.invoke({ messages: [new HumanMessage("again")] }, config)
    const state = await g.getState(config)
    expect(state.values.messages.map((m: { content: unknown }) => m.content)).toEqual(["hi", "echo 1", "approved no", "again", "echo 4"])
  })

  it("keeps threads apart, and deletes one with its writes", async () => {
    const saver = new SqliteSaver()
    await graph(saver).invoke({ messages: [new HumanMessage("a")] }, config)
    await graph(saver).invoke({ messages: [new HumanMessage("b")] }, { configurable: { thread_id: "task-2" } })
    await saver.deleteThread("task-1")
    const count = (table: string, id: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`).get(id) as { n: number }).n
    expect(count("checkpoints", "task-1")).toBe(0)
    expect(count("checkpoint_writes", "task-1")).toBe(0)
    expect(count("checkpoints", "task-2")).toBeGreaterThan(0)
    closeDb()
    openDb(file)
    const fresh = new SqliteSaver()
    expect(await fresh.getTuple(config)).toBeUndefined()
    expect((await graph(fresh).getState({ configurable: { thread_id: "task-2" } })).values.messages).toHaveLength(2)
  })

  it("lists every thread's checkpoints after a restart", async () => {
    await graph(new SqliteSaver()).invoke({ messages: [new HumanMessage("a")] }, config)
    closeDb()
    openDb(file)
    const ids: string[] = []
    for await (const t of new SqliteSaver().list({})) ids.push(String(t.config.configurable?.thread_id))
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids)).toEqual(new Set(["task-1"]))
  })
})

describe("special writes (R1.1)", () => {
  it("keeps the last interrupt or resume a task wrote, as MemorySaver does, across a restart", async () => {
    const saver = new SqliteSaver()
    const cp = { ...emptyCheckpoint(), id: "cp-1" }
    const saved = await saver.put({ configurable: { thread_id: "t", checkpoint_ns: "" } }, cp, { source: "loop", step: 0, parents: {} } as never)
    // an ordinary write keeps its first value; a special one (here a resume, index -4) is replaced
    await saver.putWrites(
      saved,
      [
        ["messages", "first"],
        ["__resume__", "first"],
      ],
      "task-a",
    )
    await saver.putWrites(
      saved,
      [
        ["messages", "second"],
        ["__resume__", "second"],
      ],
      "task-a",
    )
    const inMemory = (await saver.getTuple(saved))!.pendingWrites!.map(([, ch, v]) => `${ch}=${String(v)}`)
    closeDb()
    openDb(file)
    const restored = (await new SqliteSaver().getTuple(saved))!.pendingWrites!.map(([, ch, v]) => `${ch}=${String(v)}`)
    expect(inMemory).toEqual(expect.arrayContaining(["messages=first", "__resume__=second"]))
    expect(restored.sort()).toEqual(inMemory.sort())
  })
})
