import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { diffLines, unifiedDiff, ALIGN_CAP } from "../src/main/sandbox/diff"
import {
  authArgs,
  BASE_IMAGE,
  CLAUDE_CODE_VERSION,
  claudeArgs,
  containerEnv,
  containerName,
  dockerRunArgs,
  execArgs,
  INSTALL_CAPS,
  specialistCommand,
  SPECIALIST_MODEL,
  stopArgs,
  dockerState,
  killContainer,
  preflight,
  prepareImages,
  removeLegacy,
  SPECIALIST_IMAGE,
  type Exec,
  type ExecResult,
} from "../src/main/sandbox/docker"
import { PathRejected } from "../src/main/sandbox/paths"
import { renderPrompt, renderSystemPrompt, workPath } from "../src/main/sandbox/prompt"
import {
  addFiles,
  askDir,
  createWorkspace,
  discardWorkspace,
  prepareWorkspace,
  readManifest,
  rebaseSnapshot,
  sha256,
  writeSystemPrompt,
} from "../src/main/sandbox/workspace"

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
    expect(existsSync(askDir(ws.runDir))).toBe(true)
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

  it("copies a file of any size: a delegation's workspace has no size cap (adr:0016-let-the-orchestrator-run-the-specialists-sandbox)", () => {
    // past the 100 MB the first rounds refused
    writeFileSync(join(root, "big.apk"), Buffer.alloc(101 * 1024 * 1024))
    const ws = prepareWorkspace(data, root, ["big.apk"])
    expect(ws.files).toEqual([expect.objectContaining({ path: "big.apk", size: 101 * 1024 * 1024 })])
    discardWorkspace(data, ws.id)
  })

  it("writes the system prompt outside the workspace and discards all three directories", () => {
    const ws = prepareWorkspace(data, root, ["src/a.ts"])
    expect(writeSystemPrompt(ws, "sys")).toBe(join(ws.runDir, "system.md"))
    discardWorkspace(data, ws.id)
    for (const d of [ws.workspace, ws.runDir, ws.snapshot]) expect(existsSync(d)).toBe(false)
  })
})

describe("a sandbox's workspace (specs/specialist-sandbox R2.1–R2.3, R4.5)", () => {
  it("starts empty under the id it is given, with its ask channel", () => {
    const ws = createWorkspace(data, "box-1")
    expect(ws.workspace).toBe(join(data, "workspace", "box-1"))
    expect(readManifest(ws.snapshot)).toEqual({})
    expect(existsSync(askDir(ws.runDir))).toBe(true)
  })

  it("adds source files with their SHA-256 and scratch files under .orchestrator/, keeping what was there", () => {
    const ws = createWorkspace(data, "box-2")
    addFiles(ws, root, ["src/a.ts"], [], 1024, "limit")
    const added = addFiles(ws, root, ["src/b.ts"], [{ path: "tools/run.sh", content: Buffer.from("echo hi\n") }], 1024, "limit")
    expect(added.map((f) => f.path)).toEqual(["src/b.ts", ".orchestrator/tools/run.sh"])
    expect(readManifest(ws.snapshot)).toEqual({ "src/a.ts": sha256("export const a = 1\n"), "src/b.ts": sha256("export const b = 2\n") })
    expect(readFileSync(join(ws.workspace, ".orchestrator", "tools", "run.sh"), "utf8")).toBe("echo hi\n")
    expect(ws.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", ".orchestrator/tools/run.sh"])
  })

  it("copies nothing of a call with a path outside the source, or past the cap", () => {
    const ws = createWorkspace(data, "box-3")
    expect(() => addFiles(ws, root, ["src/a.ts", "../x"], [], 1024, "limit")).toThrow(PathRejected)
    expect(() => addFiles(ws, root, ["src/a.ts", "src/b.ts"], [], 20, "2 KB disk limit")).toThrow(/2 KB disk limit/)
    expect(existsSync(join(ws.workspace, "src", "a.ts"))).toBe(false)
    expect(readManifest(ws.snapshot)).toEqual({})
  })

  it("refuses to write through a link the sandbox planted in its workspace", () => {
    const ws = createWorkspace(data, "box-5")
    mkdirSync(join(base, "elsewhere"))
    // a junction needs no privilege on Windows; elsewhere a directory link
    symlinkSync(join(base, "elsewhere"), join(ws.workspace, "src"), process.platform === "win32" ? "junction" : "dir")
    expect(() => addFiles(ws, root, ["src/a.ts"], [], 1024, "limit")).toThrow(/src in the workspace is not a folder/)
    expect(existsSync(join(base, "elsewhere", "a.ts"))).toBe(false)
  })

  it("drops from the snapshot what is no longer a regular file", () => {
    const ws = createWorkspace(data, "box-6")
    addFiles(ws, root, ["src/a.ts"], [], 1024, "limit")
    rmSync(join(ws.workspace, "src", "a.ts"))
    mkdirSync(join(ws.workspace, "src", "a.ts"))
    rebaseSnapshot(ws, [{ path: "src/a.ts", status: "modified" }])
    expect(readManifest(ws.snapshot)).toEqual({})
  })

  it("takes the workspace as the snapshot for the files a patch changed", () => {
    const ws = createWorkspace(data, "box-4")
    addFiles(ws, root, ["src/a.ts", "src/b.ts"], [], 1024, "limit")
    writeFileSync(join(ws.workspace, "src", "a.ts"), "export const a = 9\n")
    writeFileSync(join(ws.workspace, "src", "c.ts"), "new\n")
    rebaseSnapshot(ws, [
      { path: "src/a.ts", status: "modified" },
      { path: "src/c.ts", status: "added" },
      { path: "src/b.ts", status: "deleted" },
    ])
    expect(readManifest(ws.snapshot)).toEqual({ "src/a.ts": sha256("export const a = 9\n"), "src/c.ts": sha256("new\n") })
    expect(readFileSync(join(ws.snapshot, "files", "src", "c.ts"), "utf8")).toBe("new\n")
    expect(existsSync(join(ws.snapshot, "files", "src", "b.ts"))).toBe(false)
  })
})

describe("docker run arguments (R2.1–R2.3, R3.2, R3.3)", () => {
  const spec = {
    id: "1234",
    workspace: "C:\\data\\workspace\\1234",
    runDir: "C:\\data\\runs\\1234",
    out: "C:\\data\\outputs\\1234",
    mode: "read" as const,
  }
  const after = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag)

  it("binds only the workspace at /work, the run directory read-only outside it, and its ask channel writable (specs/chat R5.2)", () => {
    const args = dockerRunArgs(spec)
    expect(after(args, "--mount")).toEqual([
      "type=volume,source=hfr-claude-config,target=/home/agent/.claude-config",
      "type=bind,source=C:\\data\\workspace\\1234,target=/work,readonly",
      "type=bind,source=C:\\data\\runs\\1234,target=/run/hfr,readonly",
      `type=bind,source=${join("C:\\data\\runs\\1234", "ask")},target=/run/hfr-ask`,
      // the specialist's own output, kept with the task (specs/rea-native R2.4)
      "type=bind,source=C:\\data\\outputs\\1234,target=/root/out",
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

  it("runs as root with only the install capabilities, a writable root and limits (adr:0016-let-the-orchestrator-run-the-specialists-sandbox)", () => {
    const args = dockerRunArgs(spec)
    expect(after(args, "--user")).toEqual(["0:0"])
    expect(after(args, "--cap-drop")).toEqual(["ALL"])
    expect(after(args, "--cap-add")).toEqual(INSTALL_CAPS)
    expect(INSTALL_CAPS).not.toContain("NET_RAW")
    expect(INSTALL_CAPS).not.toContain("SYS_ADMIN")
    expect(after(args, "--security-opt")).toEqual(["no-new-privileges"])
    expect(args).not.toContain("--read-only")
    expect(args).not.toContain("--privileged")
    expect(args.join(" ")).not.toMatch(/docker\.sock/)
    // no limit, and no tmpfs: the root filesystem is writable
    for (const flag of ["--memory", "--cpus", "--pids-limit", "--tmpfs", "--storage-opt"]) expect(args).not.toContain(flag)
  })

  it("leaves the container on Docker's default network, through no proxy (specs/sandbox-images R4.1)", () => {
    const args = dockerRunArgs(spec)
    expect(args).not.toContain("--network")
    expect(args.join(" ")).not.toMatch(/PROXY/)
  })

  it("passes only the allowlisted environment, nothing of the host's", () => {
    const env = after(dockerRunArgs(spec), "-e")
    expect(env.map((e) => e.split("=")[0]).sort()).toEqual(Object.keys(containerEnv()).sort())
    for (const e of env) expect(e).not.toMatch(/ANTHROPIC|OPENROUTER|USERPROFILE|PATH=|C:\\/i)
  })

  it("starts Claude Code with no setting source, strict MCP, file tools by mode and Bash", () => {
    const read = claudeArgs("read")
    expect(read.slice(0, 2)).toEqual(["claude", "-p"])
    expect(after(read, "--setting-sources")).toEqual([""])
    expect(read).toContain("--strict-mcp-config")
    expect(read).toContain("--restricted")
    expect(after(read, "--permission-prompts")).toEqual(["none"])
    expect(after(read, "--tools")).toEqual(["Read,Grep,Glob,Bash"])
    expect(after(read, "--model")).toEqual([SPECIALIST_MODEL])
    expect(after(read, "--input-format")).toEqual(["stream-json"])
    expect(after(read, "--system-prompt-file")).toEqual(["/run/hfr/system.md"])
    expect(after(claudeArgs("modify"), "--tools")).toEqual(["Read,Grep,Glob,Edit,Write,Bash"])
    expect(claudeArgs("read").join(" ")).not.toMatch(/dangerously|add-dir|bypassPermissions/)
    expect(claudeArgs("read")).not.toContain("--effort")
    expect(after(claudeArgs("read", undefined, "max"), "--effort")).toEqual(["max"])
  })

  it("registers the ask-user and REA MCP servers and nothing else, and allows their tools (specs/chat R5.2, specs/rea-native R2.1)", () => {
    const read = claudeArgs("read")
    expect(read).toContain("--strict-mcp-config")
    const config = JSON.parse(after(read, "--mcp-config")[0])
    expect(Object.keys(config.mcpServers)).toEqual(["hfr", "rea"])
    expect(config.mcpServers.hfr).toEqual({ type: "stdio", command: "node", args: ["/opt/hfr/ask-user.mjs", "/run/hfr-ask"] })
    expect(config.mcpServers.rea).toMatchObject({ type: "stdio", command: "node", args: ["/opt/rea/node_modules/rea-agents/scripts/rea.mjs", "mcp"] })
    // the engines the image carries, given to REA whatever environment the client passes on (R1.3)
    expect(config.mcpServers.rea.env).toMatchObject({
      JAVA_HOME: "/opt/jdk-21",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      REA_JADX_MCP_JAR: "/opt/jadx/jadx-headless-mcp.jar",
      REA_APKTOOL_COMMAND: "/usr/local/bin/apktool",
    })
    expect(config.mcpServers.rea.env.PATH).toMatch(/^\/opt\/jdk-21\/bin:.*\/usr\/bin/)
    expect(JSON.stringify(config)).not.toMatch(/ANTHROPIC|OPENROUTER|C:\\/i)
    expect(after(read, "--allowedTools")).toEqual(["Read,Grep,Glob,Bash,mcp__hfr__ask_user,mcp__rea"])
    expect(after(claudeArgs("modify"), "--allowedTools")).toEqual(["Read,Grep,Glob,Edit,Write,Bash,mcp__hfr__ask_user,mcp__rea"])
  })

  it("lets an MCP call outlast Ghidra's cold start and the longest wait for the user's answer (specs/rea-native R2.2)", () => {
    const timeout = Number(containerEnv().MCP_TOOL_TIMEOUT)
    expect(timeout).toBeGreaterThanOrEqual(330_000)
    // Settings allow a question to wait up to 1440 minutes
    expect(timeout).toBeGreaterThanOrEqual(1440 * 60_000)
    expect(after(dockerRunArgs(spec), "-e")).toContain(`MCP_TOOL_TIMEOUT=${timeout}`)
  })

  it("wraps the CLI so its process id is on record and the login volume goes back to the login user (specs/specialist-sandbox R4.4, R4.6)", () => {
    const cli = claudeArgs("read")
    const cmd = specialistCommand(cli)
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"])
    expect(cmd.slice(3)).toEqual(["sh", ...cli])
    // stdin through a saved descriptor: a background job's own `<&0` would already be /dev/null
    expect(cmd[2]).toContain('exec 3<&0\n"$@" <&3 3<&- &')
    expect(cmd[2]).toContain("/tmp/hfr-claude.pid")
    expect(cmd[2]).toContain("chown -R 1000:1000 /home/agent/.claude-config")
    expect(cmd[2]).toMatch(/exit "\$status"$/)
    // a stale process id from an earlier delegation is never signalled
    const lines = cmd[2].split("\n")
    expect(lines[0]).toBe("rm -f /tmp/hfr-claude.pid")
    expect(lines[lines.indexOf('wait "$pid"; status=$?') + 1]).toBe("rm -f /tmp/hfr-claude.pid")
  })

  it("runs the specialist in a sandbox with docker exec, and stops only its CLI there (specs/specialist-sandbox R4.1, R4.4)", () => {
    const cli = claudeArgs("modify")
    expect(execArgs("hfr-sbx-1", cli)).toEqual(["exec", "-i", "-w", "/work", "hfr-sbx-1", ...specialistCommand(cli)])
    const stop = stopArgs("hfr-sbx-1")
    expect(stop.slice(0, 2)).toEqual(["exec", "hfr-sbx-1"])
    expect(stop.join(" ")).toContain("kill")
    expect(stop.join(" ")).toContain("/tmp/hfr-claude.pid")
    expect(stop.join(" ")).not.toMatch(/\brm\b|docker kill/)
  })

  it("bakes the MCP server into the base image on a Node base, with no Claude Code (specs/sandbox-images R1.1)", () => {
    const dockerfile = readFileSync(join(import.meta.dirname, "..", "sandbox", "specialist-base", "Dockerfile"), "utf8")
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:24[^\s]*@sha256:[0-9a-f]{64}$/m)
    expect(dockerfile.match(/^FROM .*$/gm)).toEqual(["FROM ${NODE_IMAGE} AS fetch", "FROM ${NODE_IMAGE}"])
    expect(dockerfile).toContain("COPY ask-user.mjs /opt/hfr/ask-user.mjs")
    expect(dockerfile).toContain("/run/hfr-ask")
    expect(dockerfile).not.toMatch(/claude-code-releases|\/usr\/local\/bin\/claude/)
  })

  it("bakes REA and its engines into the base image, each pinned and checked against its SHA-256 (specs/rea-native R1)", () => {
    const baseDir = join(import.meta.dirname, "..", "sandbox", "specialist-base")
    const dockerfile = readFileSync(join(baseDir, "Dockerfile"), "utf8")
    for (const engine of ["JDK", "GHIDRA", "JADX", "APKTOOL"]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${engine}_URL=https://github\\.com/\\S+$`, "m"))
      expect(dockerfile).toMatch(new RegExp(`^ARG ${engine}_SHA256=[0-9a-f]{64}$`, "m"))
      expect(dockerfile).toContain(`echo "$${engine}_SHA256 `)
    }
    expect(dockerfile.match(/sha256sum -c -/g)).toHaveLength(4)
    expect(dockerfile).toMatch(/^ARG REA_VERSION=\d+\.\d+\.\d+$/m)
    // every dependency from the committed lockfile, no optional package, no install script (R1.1)
    expect(dockerfile).toContain("npm ci --omit=optional --ignore-scripts")
    expect(dockerfile).toContain("test ! -e node_modules/frida")
    expect(dockerfile).not.toMatch(/npm install --global/)
    const manifest = JSON.parse(readFileSync(join(baseDir, "rea", "package.json"), "utf8"))
    const lock = JSON.parse(readFileSync(join(baseDir, "rea", "package-lock.json"), "utf8"))
    const version = /^ARG REA_VERSION=(\S+)$/m.exec(dockerfile)![1]
    expect(manifest.dependencies["rea-agents"]).toBe(version)
    expect(lock.packages["node_modules/rea-agents"].version).toBe(version)
    const locked = Object.entries(lock.packages as Record<string, { integrity?: string; link?: boolean }>).filter(([k]) => k)
    expect(locked.length).toBeGreaterThan(100)
    for (const [name, p] of locked) expect(p.integrity, name).toMatch(/^sha512-/)
    expect(dockerfile).toContain("/opt/hfr/rea-skill")
    expect(dockerfile).toContain("COPY AGENTS.md /opt/hfr/AGENTS.md")
    expect(dockerfile).toMatch(/GHIDRA_INSTALL_DIR=\/opt\/ghidra/)
    expect(dockerfile).toMatch(/REA_JADX_MCP_JAR=\/opt\/jadx\/jadx-headless-mcp\.jar/)
    expect(dockerfile).toMatch(/REA_APKTOOL_COMMAND=\/usr\/local\/bin\/apktool/)
    expect(dockerfile).not.toMatch(/rea setup/)
  })

  it("adds only the verified CLI to the pinned base, labelled with both pins (specs/sandbox-images R2.1, R2.2)", () => {
    const dockerfile = readFileSync(join(import.meta.dirname, "..", "sandbox", "specialist", "Dockerfile"), "utf8")
    expect(dockerfile).toMatch(/^FROM \$\{BASE\}$/m)
    expect(dockerfile).toContain('LABEL hfr.claude-code="$CLAUDE_CODE_VERSION" hfr.base="$BASE"')
    expect(dockerfile).toContain("sha256sum -c -")
    const final = dockerfile.slice(dockerfile.indexOf("FROM ${BASE}"))
    expect(final.match(/^[A-Z]+ .*$/gm)?.filter((l) => !/^(FROM|ARG|LABEL) /.test(l))).toEqual(["COPY --from=verify /verify/claude /usr/local/bin/claude"])
  })

  it("runs auth commands on the login volume without any workspace", () => {
    const args = authArgs(["status", "--json"], "x")
    expect(args.slice(-4)).toEqual(["claude", "auth", "status", "--json"])
    expect(args.join(" ")).not.toContain("/work")
    expect(args).toContain("type=volume,source=hfr-claude-config,target=/home/agent/.claude-config")
    // the login container is no sandbox: it stays the non-root user on a read-only root
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000")
    expect(args).toContain("--read-only")
    expect(args).not.toContain("--cap-add")
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

describe("Docker checks (R2.6, specs/sandbox-images R2.2, R3.1, R4.2)", () => {
  const ready = `${CLAUDE_CODE_VERSION} ${BASE_IMAGE}\n`
  const healthy = { "version ": { stdout: "29.6.1\n" }, [`image inspect ${SPECIALIST_IMAGE}`]: { stdout: ready } }

  it("refuses when Docker is unavailable, saying why", async () => {
    const { exec } = fakeDocker({ "version ": { code: 1, stderr: "error during connect: pipe not found\n" } })
    expect(await dockerState(exec)).toEqual({ docker: false, dockerError: "error during connect: pipe not found", images: false })
    expect(await preflight(exec)).toMatch(/Docker is unavailable \(error during connect: pipe not found\)/)
  })

  it("refuses an image that is missing, built for another Claude Code, or on another base", async () => {
    const inspect = `image inspect ${SPECIALIST_IMAGE}`
    for (const answer of [
      { code: 1 },
      { stdout: `2.0.0 ${BASE_IMAGE}` },
      { stdout: `${CLAUDE_CODE_VERSION} ghcr.io/x/hfr-specialist-base@sha256:${"0".repeat(64)}` },
    ])
      expect(await preflight(fakeDocker({ ...healthy, [inspect]: answer }).exec)).toMatch(/missing or out of date/)
    // The first round's image carries the version label and no base label: stale.
    expect(await preflight(fakeDocker({ ...healthy, [inspect]: { stdout: `${CLAUDE_CODE_VERSION} <no value>` } }).exec)).toMatch(/out of date/)
  })

  it("passes when Docker runs and the image carries both pins, starting nothing", async () => {
    const { exec, calls } = fakeDocker(healthy)
    expect(await preflight(exec)).toBeNull()
    expect(calls.every((c) => c.startsWith("version") || c.startsWith("image inspect"))).toBe(true)
  })

  it("removes the first round's proxy, network and image, ignoring what is absent", async () => {
    const { exec, calls } = fakeDocker({
      "inspect hfr-egress": { stdout: "hfr-egress:1\n" },
      "network rm": { code: 1, stderr: "network hfr-sandbox not found" },
    })
    await removeLegacy(exec)
    expect(calls.slice(1)).toEqual(["rm -f hfr-egress", "network rm hfr-sandbox", "image rm hfr-egress:1"])
  })

  it("leaves a container named like the proxy that runs another image", async () => {
    const { exec, calls } = fakeDocker({ "inspect hfr-egress": { stdout: "nginx:latest\n" } })
    await removeLegacy(exec)
    expect(calls).not.toContain("rm -f hfr-egress")
  })

  it("kills a delegation's container by name", async () => {
    const { exec, calls } = fakeDocker({})
    await killContainer(exec, "abc")
    expect(calls).toEqual(["kill hfr-abc"])
  })

  it("pulls the pinned base, then builds the CLI on it, stopping at the first failure", async () => {
    const ok = fakeDocker(healthy)
    expect((await prepareImages(ok.exec, "/s")).ok).toBe(true)
    expect(ok.calls[0]).toBe(`pull ${BASE_IMAGE}`)
    expect(ok.calls[1]).toContain(`--build-arg BASE=${BASE_IMAGE} --build-arg CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`)
    const denied = fakeDocker({ pull: { code: 1, stderr: "denied" } })
    expect((await prepareImages(denied.exec, "/s")).ok).toBe(false)
    expect(denied.calls).toHaveLength(1)
    const bad = fakeDocker({ "build -t hfr-specialist": { code: 1, stderr: "sha256sum: WARNING: 1 computed checksum did NOT match" } })
    const r = await prepareImages(bad.exec, "/s")
    expect(r.ok).toBe(false)
    expect(r.log).toContain("did NOT match")
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
    expect(p).not.toContain("## Open unknowns")
  })

  it("asks for the contract at the end of every report, whatever its format, and lists the project's open unknowns (specs/analysis-contract R1.1, R2.4)", () => {
    for (const sys of [renderSystemPrompt(pkg), renderSystemPrompt({ ...pkg, reportFormat: "One paragraph." })]) {
      expect(sys).toMatch(/end every report with one fenced ```json block/)
      expect(sys).toContain('"constants"')
      expect(sys).toMatch(/estimated.*true.*once you looked for one/)
      expect(sys).toMatch(/close it by its id in `closes`/)
    }
    const p = renderPrompt(pkg, [{ id: "u-1", question: "Which cipher?", severity: "high", settle: "the key schedule" }])
    expect(p).toContain("## Open unknowns from earlier analyses\n- u-1 [high] Which cipher? — would be settled by: the key schedule")
  })

  it("states that the artifacts are owned or authorized, and the mode's rule", () => {
    expect(renderSystemPrompt(pkg)).toContain("owned by the user or authorized for analysis")
    expect(renderSystemPrompt(pkg)).toContain("/work is read-only")
    expect(renderSystemPrompt({ ...pkg, mode: "modify" })).toContain("proposed to the user as a patch")
    expect(renderSystemPrompt(pkg)).toContain("Evidence")
  })

  it("tells the specialist it has a root shell and the internet, and keeps its own output out of /work (specs/specialist-sandbox R4.7)", () => {
    for (const sys of [renderSystemPrompt(pkg), renderSystemPrompt(pkg, true), renderSystemPrompt({ ...pkg, mode: "modify" }, true)]) {
      expect(sys).toMatch(/root/)
      expect(sys).toContain("Bash")
      expect(sys).toContain("full internet access")
      expect(sys).toMatch(/apt-get/)
      expect(sys).toMatch(/\/root\/out or \/tmp, never in \/work/)
    }
    // a sandbox's /work is writable, so read mode asks the files be left as they are rather than calling it read-only
    expect(renderSystemPrompt(pkg, true)).not.toContain("/work is read-only")
    expect(renderSystemPrompt(pkg, true)).toContain("Leave the files in /work as they are")
  })

  it("offers the ask-user tool with a reason and a default, never to ask for authorization (specs/chat R5.2)", () => {
    const sys = renderSystemPrompt(pkg)
    expect(sys).toContain("mcp__hfr__ask_user")
    expect(sys).toMatch(/reason and a default/)
    expect(sys).toMatch(/Never ask for, or assume, ownership, authorization or purpose/)
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
      ...dockerRunArgs({ id: ws.id, workspace: "<ws>", runDir: "<run>", out: "<out>", mode: "read" }),
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

describe("the specialist as a harness of REA (specs/rea-native R2.3)", () => {
  const pkg = ContextPackageSchema.parse({ brief: "b", objective: "o", files: ["a"] })

  it("carries the operating guide the image carries, and points to REA's skill", () => {
    const guide = readFileSync(join(import.meta.dirname, "..", "sandbox", "specialist-base", "AGENTS.md"), "utf8").trim()
    const sys = renderSystemPrompt(pkg)
    expect(sys).toContain(guide)
    expect(sys).toContain("/opt/hfr/rea-skill/SKILL.md")
    expect(guide).toMatch(/Never run `rea setup`/)
    expect(guide).toMatch(/binary_session \{\}/)
    expect(guide).toMatch(/export_evidence_bundle.*\/root\/out\/evidence\//)
    expect(guide).toMatch(/record_unknown/)
    expect(guide).toMatch(/Missing evidence is never proof/)
  })

  it("names every evidence form in the default report format (R3.1)", () => {
    expect(pkg.reportFormat).toContain("<path>:<start line>-<end line>")
    expect(pkg.reportFormat).toContain("<path>@0x<address>")
    expect(pkg.reportFormat).toContain("ev_<64 hex>")
    expect(pkg.reportFormat).toContain("unk_<64 hex>")
  })
})
