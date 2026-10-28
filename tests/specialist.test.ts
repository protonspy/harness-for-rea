import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { claudeArgs } from "../src/main/sandbox/docker"
import { ClaudeAccount, spawnStart, cleanText, failureReason, isAnthropicUrl, loginUrl, parseStatus, validCode } from "../src/main/specialist/account"
import { classifyFailure, SpecialistError, SpecialistSession, type Launch } from "../src/main/specialist/executor"
import { ARGS_CAP, filesOf, fromWork, StreamReader, TEXT_CAP, type StreamEvent } from "../src/main/specialist/stream"

/* specs/claude-specialist: the stream reader, the session over a prepared launch, and the login. */

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs")

function fakeLaunch(mode: string, tools: "read" | "modify" = "read") {
  const base = mkdtempSync(join(tmpdir(), "hfr-spec-"))
  const work = join(base, "work")
  const run = join(base, "run")
  mkdirSync(join(work, "src"), { recursive: true })
  mkdirSync(run, { recursive: true })
  writeFileSync(join(work, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(run, "system.md"), "the system prompt")
  const logFile = join(base, "fake.jsonl")
  let stopped = 0
  const launch: Launch = {
    command: process.execPath,
    args: [FAKE, ...claudeArgs(tools).slice(1)],
    cwd: work,
    env: { HFR_FAKE: mode, HFR_FAKE_LOG: logFile, HFR_RUN: run, PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    stop: async () => {
      stopped++
    },
  }
  const logged = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : []
  return { launch, work, logged, stopped: () => stopped }
}

describe("StreamReader (R2.1–R2.5)", () => {
  const line = (o: unknown) => JSON.stringify(o)

  it("reads init, text, thinking, calls and results", () => {
    const r = new StreamReader()
    expect(r.line(line({ type: "system", subtype: "init", session_id: "s1", model: "opus", tools: ["Read"] }))[0]).toMatchObject({
      kind: "init",
      payload: { model: "opus" },
    })
    const calls = r.line(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Looking" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/src/a.ts" } },
          ],
        },
      }),
    )
    expect(calls.map((c) => c.kind)).toEqual(["thinking", "text", "tool.call"])
    expect(calls[2]).toMatchObject({ summary: "Read src/a.ts", payload: { tool: "Read", files: [{ path: "src/a.ts", op: "read" }] } })
    const res = r.line(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line 1" }] }] } }))
    expect(res[0]).toMatchObject({ kind: "tool.result", payload: { tool: "Read", output: "line 1" } })
    const err = r.line(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] } }))
    expect(err[0].payload.error).toBe("boom")
    expect(r.session).toBe("s1")
  })

  it("attributes calls inside a subagent to it", () => {
    const r = new StreamReader()
    r.line(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "ag", name: "Agent", input: { subagent_type: "Explore", prompt: "p" } }] } }))
    const inner = r.line(
      line({ type: "assistant", parent_tool_use_id: "ag", message: { content: [{ type: "tool_use", id: "g", name: "Grep", input: { path: "/work/src" } }] } }),
    )
    expect(inner[0].payload.subagent).toBe("Explore")
    const orphan = r.line(line({ type: "assistant", parent_tool_use_id: "zz", message: { content: [{ type: "text", text: "x" }] } }))
    expect(orphan[0].payload.subagent).toBe("general-purpose")
  })

  it("records tokens, cache tokens, cost as an estimate, duration and session", () => {
    const r = new StreamReader()
    const [e] = r.line(
      line({
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "s2",
        duration_ms: 2000,
        total_cost_usd: 0.3,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      }),
    )
    expect(e.payload).toMatchObject({ tokensIn: 10, tokensOut: 5, cacheTokens: 5, costUsd: 0.3, estimate: true, durationMs: 2000, session: "s2" })
    expect(r.result).toMatchObject({ text: "done", error: false, costUsd: 0.3 })
    const [f] = new StreamReader().line(line({ type: "result", subtype: "error_max_turns", is_error: true, usage: {} }))
    expect(f.summary).toContain("error_max_turns")
  })

  it("keeps lines it cannot read and unknown types instead of dropping them", () => {
    const r = new StreamReader()
    expect(r.line("garbage")[0]).toMatchObject({ kind: "unknown", payload: { output: "garbage" } })
    expect(r.line("[1,2]")[0].kind).toBe("unknown")
    expect(r.line(line({ type: "mystery" }))[0]).toMatchObject({ kind: "unknown", summary: "Unknown stream event type: mystery" })
    expect(r.line(line({ type: "stream_event" }))).toEqual([])
    expect(r.line("   ")).toEqual([])
  })

  it("caps text and arguments and marks them truncated", () => {
    const r = new StreamReader()
    const [t] = r.line(line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(TEXT_CAP + 10) }] } }))
    expect((t.payload.output as string).length).toBe(TEXT_CAP)
    expect(t.payload.truncated).toBe(true)
    const [c] = r.line(
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/work/a", content: "y".repeat(ARGS_CAP) } }] },
      }),
    )
    expect(c.payload.truncated).toBe(true)
    expect(c.payload.files).toEqual([{ path: "a", op: "write" }])
  })

  it("maps /work paths back and ignores tools that touch no file", () => {
    expect(fromWork("/work/src/x.ts")).toBe("src/x.ts")
    expect(fromWork("/work")).toBe(".")
    expect(fromWork("/etc/passwd")).toBe("/etc/passwd")
    expect(filesOf("Glob", { path: "/work/src" })).toEqual([{ path: "src", op: "read" }])
    expect(filesOf("Bash", { command: "ls" })).toEqual([])
    expect(filesOf("Read", {})).toEqual([])
  })
})

describe("SpecialistSession (R1.1–R1.4)", () => {
  it("runs the launch it is given, sends turns on stdin and keeps the session open between them", async () => {
    const f = fakeLaunch("answer")
    const events: StreamEvent[] = []
    const raw: string[] = []
    const s = new SpecialistSession(f.launch, { timeoutMs: 20_000, onEvent: (e) => events.push(e), onRaw: (l) => raw.push(l) })
    const first = await s.send("Look at /work/src/a.ts please")
    expect(first).toMatchObject({ text: expect.stringContaining("Turn 1: analysed src/a.ts"), costUsd: 0.42, tokensIn: 1200, cacheTokens: 60 })
    const second = await s.send("And again /work/src/a.ts")
    expect(second.text).toContain("Turn 2")
    await s.close()
    expect(events.filter((e) => e.kind === "result")).toHaveLength(2)
    expect(events.some((e) => e.kind === "tool.call" && e.payload.files?.[0]?.path === "src/a.ts")).toBe(true)
    expect(raw.length).toBeGreaterThan(5)
    const [start] = f.logged()
    expect(start.args).toContain("--strict-mcp-config")
    expect(start.system).toBe("the system prompt")
    expect(f.logged().filter((l) => l.turn)).toHaveLength(2)
  })

  it("reports an exit without a result by its last error line, classified", async () => {
    const s = new SpecialistSession(fakeLaunch("auth-fail").launch, { timeoutMs: 20_000 })
    const err = await s.send("hi").catch((e) => e)
    expect(err).toBeInstanceOf(SpecialistError)
    expect(err.kind).toBe("auth")
    await expect(s.send("again")).rejects.toThrow()
  })

  it("rejects a failed result as a plan limit", async () => {
    const s = new SpecialistSession(fakeLaunch("limit").launch, { timeoutMs: 20_000 })
    await expect(s.send("hi")).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("resets 3pm") })
    await s.close()
  })

  it("keeps unknown lines as events", async () => {
    const events: StreamEvent[] = []
    const s = new SpecialistSession(fakeLaunch("noise").launch, { timeoutMs: 20_000, onEvent: (e) => events.push(e) })
    await s.send("x")
    await s.close()
    expect(events.filter((e) => e.kind === "unknown")).toHaveLength(2)
  })

  it("stops the launch and the process on timeout and reports it", async () => {
    const f = fakeLaunch("hang")
    const s = new SpecialistSession(f.launch, { timeoutMs: 800 })
    await expect(s.send("x")).rejects.toMatchObject({ kind: "timeout" })
    await s.kill("timeout")
    expect(s.outcome).toBe("timeout")
    expect(f.stopped()).toBe(1)
  })

  it("stops on cancel and refuses to start when already cancelled", async () => {
    const f = fakeLaunch("hang")
    const ac = new AbortController()
    const s = new SpecialistSession(f.launch, { timeoutMs: 20_000, signal: ac.signal })
    const pending = s.send("x")
    setTimeout(() => ac.abort(), 200)
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" })
    expect(s.outcome).toBe("cancelled")
    expect(() => new SpecialistSession(f.launch, { timeoutMs: 1000, signal: ac.signal })).toThrow(/Cancelled/)
  })

  it("reports a launch that cannot start", async () => {
    const s = new SpecialistSession({ command: join(tmpdir(), "no-such-binary.exe"), args: [] }, { timeoutMs: 5000 })
    await expect(s.send("x")).rejects.toThrow()
  })

  it("classifies failures", () => {
    expect(classifyFailure("Please run /login").kind).toBe("auth")
    expect(classifyFailure("API Error: Overloaded").kind).toBe("limit")
    expect(classifyFailure("something odd").kind).toBe("failed")
    expect(classifyFailure("").message).toContain("the run failed")
  })
})

describe("login (R3.1, R3.2)", () => {
  const account = (mode: string) =>
    new ClaudeAccount((sub) => spawn(process.execPath, [FAKE, "auth", ...sub], { env: { ...process.env, HFR_FAKE: mode }, stdio: ["pipe", "pipe", "pipe"] }))

  it("reports the state from auth status without reading any credential", async () => {
    expect(await account("answer").state()).toEqual({ loggedIn: true, method: "claude.ai", plan: "max", email: "user@example.com" })
    expect((await account("logged-out").state()).loggedIn).toBe(false)
    expect(await new ClaudeAccount(() => spawn(join(tmpdir(), "nope.exe"))).state()).toEqual({ loggedIn: false, method: "none" })
  })

  it("exposes only the Anthropic URL and passes the code on", async () => {
    let text = ""
    const l = account("answer").login((t) => (text += t))
    await new Promise((r) => setTimeout(r, 400))
    expect(loginUrl(text)).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc")
    expect(() => l.sendCode("bad code with spaces")).toThrow(/does not look right/)
    l.sendCode("good-code-123")
    expect((await l.done).ok).toBe(true)
  })

  it("reports why a login failed", async () => {
    const l = account("answer").login(() => undefined)
    await new Promise((r) => setTimeout(r, 300))
    l.sendCode("wrong-code-456")
    const d = await l.done
    expect(d.ok).toBe(false)
    expect(failureReason(d.text)).toBe("OAuth error: invalid code")
  })

  it("stops what the child stands for when the login is cancelled", async () => {
    let stopped = 0
    const start = spawnStart(process.execPath, (sub) => ({ args: [FAKE, "auth", ...sub], stop: () => stopped++ }))
    const l = new ClaudeAccount(start).login(() => undefined)
    l.cancel()
    expect((await l.done).ok).toBe(false)
    expect(stopped).toBe(1)
    expect((await new ClaudeAccount(spawnStart(process.execPath, (sub) => ({ args: [FAKE, "auth", ...sub] }))).state()).loggedIn).toBe(true)
  })

  it("logs out and cancels", async () => {
    await account("answer").logout()
    const l = account("answer").login(() => undefined)
    l.cancel()
    expect((await l.done).ok).toBe(false)
  })

  it("accepts only Anthropic https pages and plausible codes", () => {
    expect(isAnthropicUrl("https://claude.ai/x")).toBe(true)
    expect(isAnthropicUrl("https://console.anthropic.com/x")).toBe(true)
    expect(isAnthropicUrl("http://claude.ai/x")).toBe(false)
    expect(isAnthropicUrl("https://claude.ai.evil.com/x")).toBe(false)
    expect(isAnthropicUrl("nope")).toBe(false)
    expect(loginUrl("visit https://evil.com/a then")).toBeNull()
    expect(validCode("abc")).toBe(false)
    expect(cleanText("\x1b[31mred\x1b[0m\x07")).toBe("red")
    expect(parseStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, method: "none", plan: undefined, email: undefined })
    expect(failureReason("Opening browser\n\n")).toBe("The sign-in did not finish.")
  })
})
