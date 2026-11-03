import { connect, type Socket } from "node:net"

/*
  The client of the bridge's pipe (specs/cheat-engine R1.2, R2.4): each message a 4-byte little-endian length and a
  JSON-RPC 2.0 body, one call in flight at a time, a timeout per call. The bridge serves one client at a time, so the
  connection is kept while calls come and closed once idle.
*/

/** The largest answer read from the bridge; the bridge itself refuses a request past 32 MB. */
export const ANSWER_CAP = 32 * 1024 * 1024
const IDLE_MS = 30_000

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = "BridgeError"
  }
}

export interface BridgeClientOptions {
  /** the pipe's path, or a local socket's in tests */
  path: string
  timeoutMs: number
  /** the engine its errors name, and what answers on the pipe: Cheat Engine's bridge unless said otherwise */
  engine?: string
  peer?: string
  connect?: (path: string) => Socket
}

export class BridgeClient {
  private socket: Socket | null = null
  private buffer = Buffer.alloc(0)
  private pending: { id: number; socket: Socket; resolve(v: unknown): void; reject(e: Error): void } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private idle: NodeJS.Timeout | null = null

  private readonly engine: string
  private readonly peer: string

  constructor(private readonly o: BridgeClientOptions) {
    this.engine = o.engine ?? "Cheat Engine"
    this.peer = o.peer ?? "The Cheat Engine bridge"
  }

  /** Calls one method, after any call already in flight; the bridge's error comes back as a BridgeError. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = this.o.timeoutMs): Promise<unknown> {
    return this.exclusive((send) => send(method, params), timeoutMs, method)
  }

  /**
    Runs several calls as one unit, with no other call between them: a check and the call it guards. The timeout
    counts from when the unit is queued, so a unit that waited it out behind a long scan is dropped, never sent. All
    of a unit's calls go over one connection: one that dropped between them may now reach another engine, so the
    unit fails rather than send the rest elsewhere.
  */
  exclusive<T>(
    fn: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
    timeoutMs = this.o.timeoutMs,
    label = "the call",
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    const late = () => new BridgeError(`${this.engine} did not answer ${label} within ${Math.round(timeoutMs / 1000)} s.`)
    const work = () => {
      const unit: { socket?: Socket } = {}
      return Date.now() >= deadline
        ? Promise.reject(late())
        : fn((method, params = {}) => this.send(method, params, Math.max(1, deadline - Date.now()), late, unit))
    }
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.socket?.destroy()
    this.socket = null
    this.buffer = Buffer.alloc(0)
  }

  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    return new Promise((resolve, reject) => {
      const s = (this.o.connect ?? ((p) => connect(p)))(this.o.path)
      const fail = (e: Error) => reject(new BridgeError(`${this.peer} is not answering on ${this.o.path}: ${e.message}`))
      s.once("error", fail)
      s.once("connect", () => {
        s.off("error", fail)
        this.socket = s
        this.buffer = Buffer.alloc(0)
        s.on("data", (c: Buffer) => this.data(c))
        s.on("error", () => undefined)
        s.on("close", () => {
          if (this.socket === s) this.socket = null
          // Only the call this connection carried: one already on a new connection is not its to fail.
          if (this.pending?.socket === s) this.settle(new BridgeError(`${this.peer} closed the connection.`))
        })
        resolve(s)
      })
    })
  }

  private async send(method: string, params: Record<string, unknown>, timeoutMs: number, late: () => BridgeError, unit: { socket?: Socket }): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle)
    const socket = await this.open()
    if (unit.socket && unit.socket !== socket) throw new BridgeError(`The connection to ${this.engine} was reopened during ${method}; the call is refused.`)
    unit.socket = socket
    const id = this.nextId++
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8")
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length)
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // An answer that comes late would be read as the next call's: the connection goes with the call.
          this.close()
          this.settle(late())
        }, timeoutMs)
        this.pending = {
          id,
          socket,
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        }
        socket.write(Buffer.concat([head, body]))
      })
    } finally {
      this.idle = setTimeout(() => this.close(), IDLE_MS)
      this.idle.unref?.()
    }
  }

  private settle(e: Error, value?: unknown) {
    const p = this.pending
    this.pending = null
    if (!p) return
    if (value !== undefined) p.resolve(value)
    else p.reject(e)
  }

  private data(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt32LE(0)
      if (n > ANSWER_CAP) {
        this.close()
        this.settle(new BridgeError(`The bridge's answer is larger than ${ANSWER_CAP / 1024 / 1024} MB.`))
        return
      }
      if (this.buffer.length < 4 + n) return
      const body = this.buffer.subarray(4, 4 + n).toString("utf8")
      this.buffer = this.buffer.subarray(4 + n)
      let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }
      try {
        msg = JSON.parse(body)
      } catch {
        this.close()
        this.settle(new BridgeError("The bridge answered with something that is not JSON."))
        return
      }
      if (!this.pending || msg.id !== this.pending.id) continue
      if (msg.error) this.settle(new BridgeError(msg.error.message ?? "The bridge answered with an error.", msg.error.code))
      else this.settle(new Error(), msg.result ?? null)
    }
  }
}
