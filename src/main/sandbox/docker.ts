import { spawn } from "node:child_process"
import { join } from "node:path"

/*
  The container side of a delegation (adr:0006-run-the-specialist-inside-a-container-per-task): the
  `docker run` arguments, the checks before a delegation, the image build, and killing a container.
*/

export const CLAUDE_CODE_VERSION = "2.1.310"
export const SPECIALIST_IMAGE = `hfr-specialist:${CLAUDE_CODE_VERSION}`
export const EGRESS_IMAGE = "hfr-egress:1"
export const NETWORK = "hfr-sandbox"
export const PROXY = "hfr-egress"
export const PROXY_URL = `http://${PROXY}:3128`
export const CONFIG_VOLUME = "hfr-claude-config"
const CONFIG_DIR = "/home/agent/.claude-config"
/** The non-root user the specialist image creates. */
const AGENT_UID = 1000

export type Mode = "read" | "modify"

export interface Limits {
  memoryMb: number
  cpus: number
  pidsLimit: number
}

export interface RunSpec {
  id: string
  workspace: string
  runDir: string
  mode: Mode
  limits: Limits
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
    HTTPS_PROXY: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
  }
}

/** Isolation shared by every container the app starts: user, capabilities, root filesystem, network, login volume. */
function confined(name: string, limits: Limits): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--hostname",
    "sandbox",
    "--user",
    `${AGENT_UID}:${AGENT_UID}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    `/home/agent:rw,nosuid,nodev,size=256m,uid=${AGENT_UID},gid=${AGENT_UID},mode=0700`,
    "--memory",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pidsLimit),
    "--network",
    NETWORK,
    "--mount",
    `type=volume,source=${CONFIG_VOLUME},target=${CONFIG_DIR}`,
    ...Object.entries(containerEnv()).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ]
}

/** `docker` arguments for one delegation, up to the image (specs/task-sandbox R2.1–R2.3, R3.2, R3.3). */
export function dockerRunArgs(spec: RunSpec): string[] {
  return [
    ...confined(containerName(spec.id), spec.limits),
    "--mount",
    `type=bind,source=${spec.workspace},target=/work${spec.mode === "read" ? ",readonly" : ""}`,
    "--mount",
    `type=bind,source=${spec.runDir},target=/run/hfr,readonly`,
    "-w",
    "/work",
    SPECIALIST_IMAGE,
  ]
}

export const READ_TOOLS = ["Read", "Grep", "Glob"]
export const WRITE_TOOLS = ["Edit", "Write"]

/** The Claude Code command inside the container: no setting source, no MCP, file tools only. */
export function claudeArgs(mode: Mode, model = "opus"): string[] {
  const tools = [...READ_TOOLS, ...(mode === "modify" ? WRITE_TOOLS : [])].join(",")
  return [
    "claude",
    "-p",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--system-prompt-file",
    "/run/hfr/system.md",
    "--no-session-persistence",
  ]
}

/** `docker` arguments for `claude auth …` on the login volume, with no workspace. */
export function authArgs(sub: string[], id: string): string[] {
  return [...confined(`hfr-auth-${id}`, { memoryMb: 1024, cpus: 1, pidsLimit: 128 }), "-w", "/tmp", SPECIALIST_IMAGE, "claude", "auth", ...sub]
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

/** Whether Docker answers and both images exist with the pinned Claude Code label. */
export async function dockerState(exec: Exec): Promise<DockerState> {
  const v = await exec(["version", "--format", "{{.Server.Version}}"])
  if (v.code !== 0) return { docker: false, dockerError: lastLine(v.stderr) || "Docker is not running.", images: false }
  const label = await exec(["image", "inspect", SPECIALIST_IMAGE, "--format", '{{index .Config.Labels "hfr.claude-code"}}'])
  const egress = await exec(["image", "inspect", EGRESS_IMAGE, "--format", "{{.Id}}"])
  return { docker: true, dockerError: "", images: label.code === 0 && label.stdout.trim() === CLAUDE_CODE_VERSION && egress.code === 0 }
}

/** Make sure the internal network and the egress proxy are up. */
export async function ensureNetwork(exec: Exec): Promise<string | null> {
  if ((await exec(["network", "inspect", NETWORK, "--format", "{{.Internal}}"])).code !== 0) {
    const r = await exec(["network", "create", "--internal", NETWORK])
    if (r.code !== 0) return `Could not create the ${NETWORK} network: ${lastLine(r.stderr)}`
  }
  const running = await exec(["inspect", PROXY, "--format", "{{.State.Running}}"])
  if (running.code === 0 && running.stdout.trim() === "true") return null
  if (running.code === 0) {
    const r = await exec(["start", PROXY])
    return r.code === 0 ? null : `Could not start the egress proxy: ${lastLine(r.stderr)}`
  }
  const r = await exec([
    "run",
    "-d",
    "--name",
    PROXY,
    "--restart",
    "unless-stopped",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--network",
    "bridge",
    EGRESS_IMAGE,
  ])
  if (r.code !== 0) return `Could not start the egress proxy: ${lastLine(r.stderr)}`
  const c = await exec(["network", "connect", NETWORK, PROXY])
  return c.code === 0 ? null : `Could not attach the egress proxy to ${NETWORK}: ${lastLine(c.stderr)}`
}

/**
  The check before every delegation (specs/task-sandbox R2.6): the reason to refuse, or null. A
  missing Docker or image refuses; the specialist never falls back to the host.
*/
export async function preflight(exec: Exec): Promise<string | null> {
  const s = await dockerState(exec)
  if (!s.docker) return `Docker is unavailable (${s.dockerError}). Start Docker Desktop; the specialist never runs outside its container.`
  if (!s.images) return `The sandbox images are not built or do not match Claude Code ${CLAUDE_CODE_VERSION}. Build them in Settings.`
  return ensureNetwork(exec)
}

/** Kill a delegation's container; a container already gone is not an error. */
export async function killContainer(exec: Exec, id: string): Promise<void> {
  await exec(["kill", containerName(id)])
}

/** Build the specialist image (which verifies the pinned CLI) and the egress proxy image. */
export async function buildImages(exec: Exec, sandboxDir: string): Promise<{ ok: boolean; log: string }> {
  let log = ""
  const steps: string[][] = [
    ["build", "-t", SPECIALIST_IMAGE, "--build-arg", `CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}`, join(sandboxDir, "specialist")],
    ["build", "-t", EGRESS_IMAGE, join(sandboxDir, "egress")],
  ]
  for (const args of steps) {
    const r = await exec(args)
    log += `$ docker ${args.join(" ")}\n${r.stdout}${r.stderr}\n`
    if (r.code !== 0) return { ok: false, log }
  }
  const net = await ensureNetwork(exec)
  if (net) return { ok: false, log: `${log}${net}\n` }
  return { ok: true, log }
}
