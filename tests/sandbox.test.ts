import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { diffLines, unifiedDiff, ALIGN_CAP } from "../src/main/sandbox/diff"
import {
  authArgs,
  buildImages,
  CLAUDE_CODE_VERSION,
  claudeArgs,
  containerEnv,
  containerName,
  dockerRunArgs,
  dockerState,
  ensureNetwork,
  killContainer,
  NETWORK,
  preflight,
  PROXY,
  SPECIALIST_IMAGE,
  type Exec,
  type ExecResult,
} from "../src/main/sandbox/docker"
import { PathRejected } from "../src/main/sandbox/paths"
import { renderPrompt, renderSystemPrompt, workPath } from "../src/main/sandbox/prompt"
import { discardWorkspace, prepareWorkspace, readManifest, sha256, WORKSPACE_CAP, writeSystemPrompt } from "../src/main/sandbox/workspace"

/* specs/task-sandbox: workspace, container arguments, Docker checks and context isolation. */

let base = ""
let root = ""
let data = ""

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hfr-sandbox-"))
  root = join(base, "repo")
  data = join(base, "data")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2\n")
  writeFileSync(join(root, "README.md"), "not requested\n")
})

describe("workspace (R1.1, R1.2, R1.4)", () => {
  it("creates workspace, run and snapshot directories under a random UUID", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ws.workspace).toBe(join(data, "workspace", ws.id))
    expect(ws.runDir).toBe(join(data, "runs", ws.id))
    expect(ws.snapshot).toBe(join(data, "snapshots", ws.id))
    expect(prepareWorkspace(data, root, ["src/a.ts"]).id).not.toBe(ws.id)
  })

  it("copies only the named files at their relative paths and records their SHA-256", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts", "src\\b.ts", "src/a.ts"])
    expect(readFileSync(join(ws.workspace, "src", "a.ts"), "utf8")).toBe("export const a = 1\n")
    expect(existsSync(join(ws.workspace, "README.md"))).toBe(false)
    expect(ws.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(readManifest(ws.snapshot)).toEqual({ "src/a.ts": sha256("export const a = 1\n"), "src/b.ts": sha256("export const b = 2\n") })
    expect(readFileSync(join(ws.snapshot, "files", "src", "b.ts"), "utf8")).toBe("export const b = 2\n")
  })

  it("copies a file named twice with different case once on Windows", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts", "SRC/A.ts"])
    expect(ws.files).toHaveLength(process.platform === "win32" ? 1 : 2)
  })

  it("rejects the delegation on a path outside the root, creating nothing", () => {
    expect(() => prepareWorkspace(data, root, ["src/a.ts", "../x"])).toThrow(PathRejected)
    expect(existsSync(join(data, "workspace"))).toBe(false)
  })

  it("rejects files beyond the workspace size limit", () => {
    writeFileSync(join(root, "big.bin"), Buffer.alloc(WORKSPACE_CAP + 1))
    expect(() => prepareWorkspace(data, root, ["big.bin"])).toThrow(/workspace limit/)
  })

  it("writes the system prompt outside the workspace and discards all three directories", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    expect(writeSystemPrompt(ws, "sys")).toBe(join(ws.runDir, "system.md"))
    discardWorkspace(data, ws.id)
    for (const d of [ws.workspace, ws.runDir, ws.snapshot]) expect(existsSync(d)).toBe(false)
  })
})

describe("docker run arguments (R2.1–R2.3, R3.2, R3.3)", () => {
  const spec = {
    id: "1234",
    workspace: "C:\\data\\workspace\\1234",
    runDir: "C:\\data\\runs\\1234",
    mode: "read" as const,
    limits: { memoryMb: 2048, cpus: 2, pidsLimit: 256 },
  }
  const after = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag)

  it("binds only the workspace at /work and the run directory read-only outside it", () => {
    const args = dockerRunArgs(spec)
    expect(after(args, "--mount")).toEqual([
      "type=volume,source=hfr-claude-config,target=/home/agent/.claude-config",
      "type=bind,source=C:\\data\\workspace\\1234,target=/work,readonly",
      "type=bind,source=C:\\data\\runs\\1234,target=/run/hfr,readonly",
    ])
    expect(args).not.toContain("-v")
    expect(after(args, "-w")).toEqual(["/work"])
    expect(args.at(-1)).toBe(SPECIALIST_IMAGE)
    expect(after(args, "--name")).toEqual([containerName("1234")])
  })

  it("refuses a mount source that could add mount options", () => {
    expect(() => dockerRunArgs({ ...spec, workspace: "C:/Users/a,b/ws" })).toThrow(/comma or quote/)
    expect(() => dockerRunArgs({ ...spec, runDir: 'C:/x"y' })).toThrow(/comma or quote/)
  })

  it("mounts /work writable only in modify mode", () => {
    expect(dockerRunArgs({ ...spec, mode: "modify" })).toContain("type=bind,source=C:\\data\\workspace\\1234,target=/work")
  })

  it("runs as a non-root user with every capability dropped, a read-only root and limits", () => {
    const args = dockerRunArgs(spec)
    expect(after(args, "--user")).toEqual(["1000:1000"])
    expect(after(args, "--cap-drop")).toEqual(["ALL"])
    expect(after(args, "--security-opt")).toEqual(["no-new-privileges"])
    expect(args).toContain("--read-only")
    expect(after(args, "--memory")).toEqual(["2048m"])
    expect(after(args, "--cpus")).toEqual(["2"])
    expect(after(args, "--pids-limit")).toEqual(["256"])
    expect(after(args, "--network")).toEqual([NETWORK])
  })

  it("passes only the allowlisted environment, nothing of the host's", () => {
    const env = after(dockerRunArgs(spec), "-e")
    expect(env.map((e) => e.split("=")[0]).sort()).toEqual(Object.keys(containerEnv()).sort())
    expect(env).toContain(`HTTPS_PROXY=http://${PROXY}:3128`)
    for (const e of env) expect(e).not.toMatch(/ANTHROPIC|OPENROUTER|USERPROFILE|PATH=|C:\\/i)
  })

  it("starts Claude Code with no setting source, strict MCP and file tools by mode", () => {
    const read = claudeArgs("read")
    expect(read.slice(0, 2)).toEqual(["claude", "-p"])
    expect(after(read, "--setting-sources")).toEqual([""])
    expect(read).toContain("--strict-mcp-config")
    expect(read).toContain("--restricted")
    expect(after(read, "--permission-prompts")).toEqual(["none"])
    expect(after(read, "--tools")).toEqual(["Read,Grep,Glob"])
    expect(after(read, "--model")).toEqual(["opus"])
    expect(after(read, "--input-format")).toEqual(["stream-json"])
    expect(after(read, "--system-prompt-file")).toEqual(["/run/hfr/system.md"])
    expect(after(claudeArgs("modify"), "--tools")).toEqual(["Read,Grep,Glob,Edit,Write"])
    expect(claudeArgs("read").join(" ")).not.toMatch(/Bash|dangerously|add-dir/)
    expect(claudeArgs("read")).not.toContain("--effort")
    expect(after(claudeArgs("read", "opus", "max"), "--effort")).toEqual(["max"])
  })

  it("runs auth commands on the login volume without any workspace", () => {
    const args = authArgs(["status", "--json"], "x")
    expect(args.slice(-4)).toEqual(["claude", "auth", "status", "--json"])
    expect(args.join(" ")).not.toContain("/work")
    expect(args).toContain("type=volume,source=hfr-claude-config,target=/home/agent/.claude-config")
  })
})

function fakeDocker(answers: Record<string, Partial<ExecResult>>): { exec: Exec; calls: string[] } {
  const calls: string[] = []
  const exec: Exec = async (args) => {
    const key = args.join(" ")
    calls.push(key)
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k))
    return { code: 0, stdout: "", stderr: "", ...(hit?.[1] ?? {}) }
  }
  return { exec, calls }
}

describe("Docker checks (R2.4–R2.6)", () => {
  const healthy = {
    "version ": { stdout: "29.6.1\n" },
    [`image inspect ${SPECIALIST_IMAGE}`]: { stdout: `${CLAUDE_CODE_VERSION}\n` },
    "inspect hfr-egress": { stdout: "true\n" },
  }

  it("refuses when Docker is unavailable, saying why", async () => {
    const { exec } = fakeDocker({ "version ": { code: 1, stderr: "error during connect: pipe not found\n" } })
    expect(await dockerState(exec)).toEqual({ docker: false, dockerError: "error during connect: pipe not found", images: false })
    expect(await preflight(exec)).toMatch(/Docker is unavailable \(error during connect: pipe not found\)/)
  })

  it("refuses when the image is missing or built for another Claude Code version", async () => {
    expect(await preflight(fakeDocker({ ...healthy, [`image inspect ${SPECIALIST_IMAGE}`]: { code: 1 } }).exec)).toMatch(/not built/)
    expect(await preflight(fakeDocker({ ...healthy, [`image inspect ${SPECIALIST_IMAGE}`]: { stdout: "2.0.0" } }).exec)).toMatch(/not built/)
  })

  it("passes when Docker, images, network and proxy are up", async () => {
    expect(await preflight(fakeDocker(healthy).exec)).toBeNull()
  })

  it("creates the internal network and starts the proxy when missing", async () => {
    const { exec, calls } = fakeDocker({ "network inspect": { code: 1 }, "inspect hfr-egress": { code: 1 } })
    expect(await ensureNetwork(exec)).toBeNull()
    expect(calls).toContain(`network create --internal ${NETWORK}`)
    expect(calls.some((c) => c.startsWith(`run -d --name ${PROXY}`))).toBe(true)
    expect(calls).toContain(`network connect ${NETWORK} ${PROXY}`)
  })

  it("restarts a stopped proxy and reports a failure to", async () => {
    const stopped = fakeDocker({ "inspect hfr-egress": { stdout: "false" } })
    expect(await ensureNetwork(stopped.exec)).toBeNull()
    expect(stopped.calls).toContain(`start ${PROXY}`)
    expect(await ensureNetwork(fakeDocker({ "inspect hfr-egress": { stdout: "false" }, "start ": { code: 1, stderr: "boom" } }).exec)).toMatch(/boom/)
    expect(await ensureNetwork(fakeDocker({ "network inspect": { code: 1 }, "network create": { code: 1, stderr: "denied" } }).exec)).toMatch(/denied/)
  })

  it("kills a delegation's container by name", async () => {
    const { exec, calls } = fakeDocker({})
    await killContainer(exec, "abc")
    expect(calls).toEqual(["kill hfr-abc"])
  })

  it("builds both images, stopping at the first failure", async () => {
    const ok = fakeDocker(healthy)
    expect((await buildImages(ok.exec, "/s")).ok).toBe(true)
    expect(ok.calls[0]).toContain(`--build-arg CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`)
    const bad = fakeDocker({ "build -t hfr-specialist": { code: 1, stderr: "sha256sum: WARNING: 1 computed checksum did NOT match" } })
    const r = await buildImages(bad.exec, "/s")
    expect(r.ok).toBe(false)
    expect(r.log).toContain("did NOT match")
    expect(bad.calls).toHaveLength(1)
  })
})

describe("context isolation (R3.1, R3.2, R3.4)", () => {
  const pkg = ContextPackageSchema.parse({
    brief: "The user owns this parser and is debugging it.",
    objective: "Find why the parser drops the last token",
    mode: "read",
    files: ["src/parser.ts", "src/lexer.ts"],
    excerpts: [{ path: "src/parser.ts", startLine: 10, endLine: 40, note: "the loop" }],
    environment: ["TypeScript 6"],
    questions: ["Where is the token dropped?"],
    constraints: ["Do not suggest a rewrite"],
  })

  it("renders every package field with paths under /work", () => {
    const p = renderPrompt(pkg)
    expect(p).toContain("## Objective\nFind why the parser drops the last token")
    expect(p).toContain("- /work/src/parser.ts\n- /work/src/lexer.ts")
    expect(p).toContain("- /work/src/parser.ts:10-40 — the loop")
    expect(p).toContain("- TypeScript 6")
    expect(p).toContain("1. Where is the token dropped?")
    expect(p).toContain("- Do not suggest a rewrite")
    expect(workPath("\\a\\b.ts")).toBe("/work/a/b.ts")
  })

  it("omits empty sections", () => {
    const p = renderPrompt(ContextPackageSchema.parse({ brief: "b", objective: "x", files: ["a"] }))
    expect(p).not.toContain("## Questions")
  })

  it("states that the artifacts are owned or authorized, and the mode's rule", () => {
    expect(renderSystemPrompt(pkg)).toContain("owned by the user or authorized for analysis")
    expect(renderSystemPrompt(pkg)).toContain("/work is read-only")
    expect(renderSystemPrompt({ ...pkg, mode: "modify" })).toContain("proposed to the user as a patch")
    expect(renderSystemPrompt(pkg)).toContain("Evidence")
  })

  it("has no field for the user's request or the orchestrator's conversation", () => {
    expect(ContextPackageSchema.safeParse({ brief: "b", objective: "x", files: ["a"], request: "the user's whole request" }).success).toBe(false)
    expect(ContextPackageSchema.safeParse({ brief: "b", objective: "x", files: ["a"], messages: [] }).success).toBe(false)
  })

  it("carries no host path, host environment variable or other task's data in a rendered run", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    const run = [
      renderSystemPrompt(pkg),
      renderPrompt(pkg),
      ...dockerRunArgs({ id: ws.id, workspace: "<ws>", runDir: "<run>", mode: "read", limits: { memoryMb: 1, cpus: 1, pidsLimit: 32 } }),
      ...claudeArgs("read"),
    ].join("\n")
    expect(run).not.toContain(root)
    expect(run).not.toContain(data)
    expect(run).not.toContain(tmpdir())
    for (const [k, v] of Object.entries(process.env)) if (v && v.length > 6 && !["true", "false"].includes(v)) expect(run, k).not.toContain(v)
    expect(run).not.toContain("not requested")
  })
})

describe("diff", () => {
  it("aligns lines and shows hunks with context", () => {
    const d = unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk\n", "x.txt")
    expect(d).toBe(["--- a/x.txt", "+++ b/x.txt", "@@ -2,9 +2,10 @@", " b", " c", " d", "-e", "+E", " f", " g", " h", " i", " j", "+k"].join("\n"))
    expect(unifiedDiff("same\n", "same\n", "x")).toBe("")
  })

  it("splits distant changes into separate hunks", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")
    const b = a.replace("l1\n", "L1\n").replace("l18", "L18")
    expect(unifiedDiff(a, b, "f").match(/^@@/gm)).toHaveLength(2)
  })

  it("replaces the whole file when the alignment would be too large", () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(ALIGN_CAP)) + 1 }, (_, i) => `x${i}`)
    const ops = diffLines(big, [...big].reverse())
    expect(ops.filter((o) => o.kind === " ")).toHaveLength(0)
  })
})
