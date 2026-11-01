import { MemorySaver, type Checkpoint, type CheckpointMetadata } from "@langchain/langgraph"
import type { RunnableConfig } from "@langchain/core/runnables"
import { getDb } from "../db"

/*
  The orchestrator's conversations, kept across a restart
  (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted, specs/task-persistence R1):
  `MemorySaver` with every checkpoint and write also stored in the app's database, and a thread loaded back
  into its maps the first time it is read or written. What a checkpoint holds stays LangGraph's to decide;
  this only keeps the bytes `MemorySaver` keeps.
*/

type Row = Record<string, unknown>
type ListOptions = Parameters<MemorySaver["list"]>[1]
type PendingWrite = Parameters<MemorySaver["putWrites"]>[1][number]

const bytes = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer))

/** The key `MemorySaver` files a checkpoint's writes under. */
const writesKey = (threadId: string, ns: string, checkpointId: string) => JSON.stringify([threadId, ns, checkpointId])

export class SqliteSaver extends MemorySaver {
  private readonly loaded = new Set<string>()

  /** Bring one thread, or every thread, from the database into the parent's maps, once. */
  private load(threadId: unknown) {
    const db = getDb()
    const ids =
      typeof threadId === "string" ? [threadId] : (db.prepare("SELECT DISTINCT thread_id FROM checkpoints").all() as Row[]).map((r) => String(r.thread_id))
    for (const id of ids) {
      if (this.loaded.has(id)) continue
      this.loaded.add(id)
      for (const r of db.prepare("SELECT ns, id, parent_id, checkpoint, metadata FROM checkpoints WHERE thread_id = ?").all(id) as Row[]) {
        const ns = String(r.ns)
        this.storage[id] ??= Object.create(null)
        this.storage[id][ns] ??= Object.create(null)
        this.storage[id][ns][String(r.id)] ??= [bytes(r.checkpoint), bytes(r.metadata), r.parent_id === null ? undefined : String(r.parent_id)]
      }
      for (const r of db
        .prepare("SELECT ns, checkpoint_id, task_id, idx, channel, value, task_path FROM checkpoint_writes WHERE thread_id = ?")
        .all(id) as Row[]) {
        const key = writesKey(id, String(r.ns), String(r.checkpoint_id))
        this.writes[key] ??= Object.create(null)
        this.writes[key][`${String(r.task_id)},${Number(r.idx)}`] ??= [String(r.task_id), String(r.channel), bytes(r.value), String(r.task_path)]
      }
    }
  }

  async getTuple(config: RunnableConfig) {
    this.load(config.configurable?.thread_id)
    return super.getTuple(config)
  }

  async *list(config: RunnableConfig, options?: ListOptions) {
    this.load(config.configurable?.thread_id)
    yield* super.list(config, options)
  }

  async getDeltaChannelHistory(options: { config: RunnableConfig; channels: string[] }) {
    this.load(options.config.configurable?.thread_id)
    return super.getDeltaChannelHistory(options)
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    const threadId = config.configurable?.thread_id
    this.load(threadId)
    const saved = await super.put(config, checkpoint, metadata)
    const ns = String(saved.configurable?.checkpoint_ns ?? "")
    const [cp, meta, parent] = this.storage[String(threadId)][ns][checkpoint.id]
    getDb()
      .prepare("INSERT OR REPLACE INTO checkpoints (thread_id, ns, id, parent_id, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(threadId), ns, checkpoint.id, parent ?? null, cp, meta)
    return saved
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string) {
    const threadId = String(config.configurable?.thread_id)
    const ns = String(config.configurable?.checkpoint_ns ?? "")
    const checkpointId = String(config.configurable?.checkpoint_id)
    this.load(threadId)
    await super.putWrites(config, writes, taskId, taskPath)
    // What the parent now holds for this task's writes, row for row: it keeps the first of an ordinary write and
    // replaces a special one (an error, interrupt or resume, at a negative index), and so does the database.
    const sql = (verb: string) =>
      getDb().prepare(
        `INSERT ${verb} INTO checkpoint_writes (thread_id, ns, checkpoint_id, task_id, idx, channel, value, task_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    const keep = sql("OR IGNORE")
    const replace = sql("OR REPLACE")
    for (const [inner, [task, channel, value, path]] of Object.entries(this.writes[writesKey(threadId, ns, checkpointId)] ?? {})) {
      if (task !== taskId) continue
      const idx = Number(inner.slice(inner.lastIndexOf(",") + 1))
      ;(idx < 0 ? replace : keep).run(threadId, ns, checkpointId, task, idx, channel, value, path ?? "")
    }
  }

  async deleteThread(threadId: string) {
    await super.deleteThread(threadId)
    this.loaded.delete(threadId)
    getDb().prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId)
    getDb().prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId)
  }
}
