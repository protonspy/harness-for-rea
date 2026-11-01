import { spawn } from "node:child_process"
import { join } from "node:path"
import type { SpecialistEffort } from "@shared/types"
import pins from "../../../sandbox/images.json"
import { askDir } from "./workspace"

/*
  The container side of a delegation (adr:0006-run-the-specialist-inside-a-container-per-task): the
  `docker run` arguments, the checks before a delegation, preparing the image, and killing a container.
*/

export const CLAUDE_CODE_VERSION = "2.1.310"
export const SPECIALIST_IMAGE = `hfr-specialist:${CLAUDE_CODE_VERSION}`
/** The published base the specialist image is built on, by digest (adr:0012-pull-the-specialists-base-image-from-ghcr). */
export const BASE_IMAGE = pins.specialistBase.ref
/** What the first round left behind: the egress proxy, its image and its internal network (adr:0013-give-the-sandboxes-full-internet-access). */
export const LEGACY = { proxy: "hfr-egress", image: "hfr-egress:1", network: "hfr-sandbox" }
export const CONFIG_VOLUME = "hfr-claude-config"
const CONFIG_DIR = "/home/agent/.claude-config"
/** The non-root user the specialist image creates, which the login container runs as. */
const AGENT_UID = 1000
/** The capabilities a root sandbox keeps, enough to install packages (adr:0015-run-the-task-container-as-root). */
export const INSTALL_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"]
/** Where the specialist's wrapper records the CLI's process id, so a stop can reach it inside a sandbox that outlives it. */
export const CLAUDE_PID_FILE = "/tmp/hfr-claude.pid"

export type Mode = "read" | "modify"

/** Resource limits of a container; one left out is no limit (adr:0016-let-the-orchestrator-run-the-specialists-sandbox). */
export interface Limits {
  memoryMb?: number
  cpus?: number
  pidsLimit?: number
}

export interface RunSpec {
  id: string
  workspace: string
  runDir: string
  /** the specialist's output folder, kept with the task (specs/rea-native R2.4) */
  out: string
  mode: Mode
}

/** The `docker run` flags for the limits that are set, and none for one left out. */
export function limitArgs(limits: Limits): string[] {
  return [
    ...(limits.memoryMb === undefined ? [] : ["--memory", `${limits.memoryMb}m`]),
    ...(limits.cpus === undefined ? [] : ["--cpus", String(limits.cpus)]),
    ...(limits.pidsLimit === undefined ? [] : ["--pids-limit", String(limits.pidsLimit)]),
  ]
}

export function containerName(id: string): string {
  return `hfr-${id}`
}

/**
  The only environment the container gets. Nothing from the host: no path, no user, no key
  (specs/task-sandbox R3.2).
*/
export function containerEnv(): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    // An MCP call may wait on Ghidra's cold start, up to 330 s (specs/rea-native R2.2).
    MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
  }
}

/** How long one MCP call may take: ten minutes, past Ghidra's cold start. */
export const MCP_TOOL_TIMEOUT_MS = 600_000
/** REA's entry point in the base image's global npm root, run as an MCP server over stdio. */
export const REA_ENTRY = "/usr/local/lib/node_modules/rea-agents/scripts/rea.mjs"
/** The REA server's tools, as Claude Code allows them all. */
export const REA_TOOLS = "mcp__rea"

/**
  What REA's server is started with: the engines the base image carries, the PATH its `ps` and Java need, and a
  quiet log (specs/rea-native R1.3, R2.1). Set here too, so it holds whatever environment the client passes on.
*/
export function reaEnv(): Record<string, string> {
  return {
    HOME: "/root",
    PATH: "/opt/jdk-21/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    JAVA_HOME: "/opt/jdk-21",
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
    REA_JADX_MCP_JAR: "/opt/jadx/jadx-headless-mcp.jar",
    REA_APKTOOL_COMMAND: "/usr/local/bin/apktool",
    REA_LOG_LEVEL: "warn",
  }
}

/**
  The user, capabilities and root filesystem of a container: a specialist's sandbox runs as root with only the
  capabilities installing packages needs and a writable root (adr:0016-let-the-orchestrator-run-the-specialists-sandbox);
  the login container stays the non-root user on a read-only root.
*/
export function identity(root: boolean): string[] {
  const caps = ["--cap-drop", "ALL", ...(root ? INSTALL_CAPS.flatMap((c) => ["--cap-add", c]) : [])]
  return root
    ? ["--user", "0:0", ...caps, "--security-opt", "no-new-privileges"]
    : ["--user", `${AGENT_UID}:${AGENT_UID}`, ...caps, "--security-opt", "no-new-privileges", "--read-only"]
}

/**
  Isolation shared by the containers the app runs per call: identity, limits, login volume. The network is
  Docker's default, with full internet access (adr:0013-give-the-sandboxes-full-internet-access). A root
  sandbox writes to its own root filesystem and has no limit; the login container, on a read-only root, gets
  small tmpfs mounts and the limits it is given.
*/
function confined(name: string, limits: Limits, root: boolean): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--hostname",
    "sandbox",
    ...identity(root),
    ...(root
      ? []
      : ["--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", `/home/agent:rw,nosuid,nodev,size=256m,uid=${AGENT_UID},gid=${AGENT_UID},mode=0700`]),
    ...limitArgs(limits),
    ...loginVolume(),
  ]
}

/** The shared login volume and the only environment a container gets. */
export function loginVolume(): string[] {
  return ["--mount", `type=volume,source=${CONFIG_VOLUME},target=${CONFIG_DIR}`, ...Object.entries(containerEnv()).flatMap(([k, v]) => ["-e", `${k}=${v}`])]
}

/** A bind source goes into a comma-separated `--mount` value, so a comma or quote in it would add options. */
export function mountSource(path: string): string {
  if (/[,"]/.test(path)) throw new Error(`The app's data folder path contains a comma or quote, which Docker cannot mount safely: ${path}`)
  return path
}

/**
  `docker` arguments for one delegation, up to the image (specs/task-sandbox R2.1–R2.3, R3.2, R3.3): the
  workspace, the run directory read-only, and its ask channel, the one writable path outside /work
  (specs/chat R5.2, adr:0008-ask-the-user-from-the-specialist-over-the-run-channel).
*/
export function dockerRunArgs(spec: RunSpec): string[] {
  return [
    ...confined(containerName(spec.id), {}, true),
    "--mount",
    `type=bind,source=${mountSource(spec.workspace)},target=/work${spec.mode === "read" ? ",readonly" : ""}`,
    "--mount",
    `type=bind,source=${mountSource(spec.runDir)},target=/run/hfr,readonly`,
    "--mount",
    `type=bind,source=${mountSource(askDir(spec.runDir))},target=${ASK_CHANNEL}`,
    "--mount",
    `type=bind,source=${mountSource(spec.out)},target=/root/out`,
    "-w",
    "/work",
    SPECIALIST_IMAGE,
  ]
}

/**
  The CLI run through `sh`, so its process id is on record for a stop, and the login volume is handed back to the
  login container's user once it ends: a root CLI writes it as root (specs/specialist-sandbox R4.4, R4.6). The CLI
  gets the wrapper's stdin through descriptor 3: a non-interactive shell points a background job's stdin at
  /dev/null before its own redirections, so `<&0` alone would hand it /dev/null.
*/
export function specialistCommand(cli: string[]): string[] {
  const script = [
    `rm -f ${CLAUDE_PID_FILE}`,
    "exec 3<&0",
    `"$@" <&3 3<&- & pid=$!`,
    "exec 3<&-",
    `echo "$pid" > ${CLAUDE_PID_FILE}`,
    `wait "$pid"; status=$?`,
    `rm -f ${CLAUDE_PID_FILE}`,
    `chown -R ${AGENT_UID}:${AGENT_UID} ${CONFIG_DIR} 2>/dev/null`,
    `exit "$status"`,
  ].join("\n")
  return ["sh", "-c", script, "sh", ...cli]
}

/** `docker exec` of the specialist into a sandbox the orchestrator created (specs/specialist-sandbox R4.1). */
export function execArgs(box: string, cli: string[]): string[] {
  return ["exec", "-i", "-w", "/work", box, ...specialistCommand(cli)]
}

/** Stops the specialist's CLI inside a sandbox and leaves the sandbox running (specs/specialist-sandbox R4.4). */
export function stopArgs(box: string): string[] {
  return ["exec", box, "sh", "-c", `kill "$(cat ${CLAUDE_PID_FILE})" 2>/dev/null; true`]
}

export const SHELL_TOOLS = ["Bash"]
export const READ_TOOLS = ["Read", "Grep", "Glob"]
export const WRITE_TOOLS = ["Edit", "Write"]
/** Where the ask channel is mounted in the specialist's container. */
export const ASK_CHANNEL = "/run/hfr-ask"
/** The ask-user MCP server's one tool, as Claude Code names it. */
export const ASK_USER_TOOL = "mcp__hfr__ask_user"

/** The specialist's MCP servers, both baked into its image: ask-user, and REA (adr:0018-make-rea-native-to-the-specialist). */
export function mcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      hfr: { type: "stdio", command: "node", args: ["/opt/hfr/ask-user.mjs", ASK_CHANNEL] },
      rea: { type: "stdio", command: "node", args: [REA_ENTRY, "mcp"], env: reaEnv() },
    },
  })
}

/** The Claude Code command inside the container: no setting source, the ask-user MCP server alone, file tools and a shell. */
export function claudeArgs(mode: Mode, model = "opus", effort: SpecialistEffort = "default"): string[] {
  const tools = [...READ_TOOLS, ...(mode === "modify" ? WRITE_TOOLS : []), ...SHELL_TOOLS].join(",")
  return [
    "claude",
    "-p",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig(),
    // File tools confined to the working directory, Bash the one command-running tool, nothing that would prompt.
    "--restricted",
    "--permission-prompts",
    "none",
    "--disable-slash-commands",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(effort === "default" ? [] : ["--effort", effort]),
    "--tools",
    tools,
    "--allowedTools",
    `${tools},${ASK_USER_TOOL},${REA_TOOLS}`,
    // The login volume under the home directory holds the plan's token: no file tool may reach it. The shell
    // can, as root; adr:0016-let-the-orchestrator-run-the-specialists-sandbox accepts that exposure.
    "--disallowedTools",
    "Read(//home/agent/**),Edit(//home/agent/**)",
    "--system-prompt-file",
    "/run/hfr/system.md",
    "--no-session-persistence",
  ]
}

/** `docker` arguments for `claude auth …` on the login volume, with no workspace. */
export function authArgs(sub: string[], id: string): string[] {
  return [...confined(`hfr-auth-${id}`, { memoryMb: 1024, cpus: 1, pidsLimit: 128 }, false), "-w", "/tmp", SPECIALIST_IMAGE, "claude", "auth", ...sub]
}

/* ---------- running docker ---------- */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (args: string[]) => Promise<ExecResult>

export const dockerExec: Exec = (args) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")))
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")))
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }))
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

const lastLine = (s: string) =>
  s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? ""

export interface DockerState {
  docker: boolean
  dockerError: string
  images: boolean
}

/** The labels a ready specialist image carries: the pinned Claude Code version and the pinned base (specs/sandbox-images R2.2). */
const READY = `${CLAUDE_CODE_VERSION} ${BASE_IMAGE}`

/** Whether Docker answers and the specialist image was built from both pins. */
export async function dockerState(exec: Exec): Promise<DockerState> {
  const v = await exec(["version", "--format", "{{.Server.Version}}"])
  if (v.code !== 0) return { docker: false, dockerError: lastLine(v.stderr) || "Docker is not running.", images: false }
  const labels = await exec([
    "image",
    "inspect",
    SPECIALIST_IMAGE,
    "--format",
    '{{index .Config.Labels "hfr.claude-code"}} {{index .Config.Labels "hfr.base"}}',
  ])
  return { docker: true, dockerError: "", images: labels.code === 0 && labels.stdout.trim() === READY }
}

/** Remove the egress proxy, its image and its network if an earlier version left them (specs/sandbox-images R4.2). */
export async function removeLegacy(exec: Exec): Promise<void> {
  // Only the container the first round started from its own image; one the user named alike stays.
  const proxy = await exec(["inspect", LEGACY.proxy, "--format", "{{.Config.Image}}"])
  if (proxy.code === 0 && proxy.stdout.trim() === LEGACY.image) await exec(["rm", "-f", LEGACY.proxy])
  await exec(["network", "rm", LEGACY.network])
  await exec(["image", "rm", LEGACY.image])
}

/**
  The check before every delegation (specs/task-sandbox R2.6): the reason to refuse, or null. A
  missing Docker or image refuses; the specialist never falls back to the host.
*/
export async function preflight(exec: Exec): Promise<string | null> {
  const s = await dockerState(exec)
  if (!s.docker) return `Docker is unavailable (${s.dockerError}). Start Docker Desktop; the specialist never runs outside its container.`
  if (!s.images)
    return `The sandbox image is missing or out of date for Claude Code ${CLAUDE_CODE_VERSION}. The app prepares it at start; prepare it again from Settings.`
  return null
}

/** Kill a delegation's container; a container already gone is not an error. */
export async function killContainer(exec: Exec, id: string): Promise<void> {
  await exec(["kill", containerName(id)])
}

/** Pull the pinned base and build the specialist image on it, adding the verified CLI (specs/sandbox-images R2.1, R3.1). */
export async function prepareImages(exec: Exec, sandboxDir: string): Promise<{ ok: boolean; log: string }> {
  let log = ""
  const steps: string[][] = [
    ["pull", BASE_IMAGE],
    [
      "build",
      "-t",
      SPECIALIST_IMAGE,
      "--build-arg",
      `BASE=${BASE_IMAGE}`,
      "--build-arg",
      `CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`,
      join(sandboxDir, "specialist"),
    ],
  ]
  for (const args of steps) {
    const r = await exec(args)
    log += `$ docker ${args.join(" ")}\n${r.stdout}${r.stderr}\n`
    if (r.code !== 0) return { ok: false, log }
  }
  return { ok: true, log }
}
