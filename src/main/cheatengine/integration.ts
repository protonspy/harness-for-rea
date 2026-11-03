import { execFile } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  BRIDGE_FILE,
  BRIDGE_PIPE,
  BRIDGE_VERSION,
  bridgeCall,
  CHEAT_ENGINE_INFO,
  CHEAT_ENGINE_TOOLS,
  CheatEngineConfigSchema,
  ProcessTargetSchema,
  type CheatEngineConfig,
} from "@shared/cheatengine"
import type { IntegrationActionResult, IntegrationCheck } from "@shared/integrations"
import skill from "../../../sandbox/skills/cheat-engine/SKILL.md?raw"
import type { HostIntegration, IntegrationSession } from "../integrations/registry"
import { BridgeClient } from "./pipe"

/*
  The host side of the Cheat Engine integration (specs/cheat-engine): its checks, the bridge's install, `status`,
  what an approval shows of a process, and the session on the approved process, which opens only that process and
  refuses a call while Cheat Engine has another open or once the process exited (R3.3, R3.4).
*/

/** One call's longest wait: a first value scan of a large process takes a while. */
export const CALL_TIMEOUT_MS = 120_000
const PING_TIMEOUT_MS = 3_000

export interface ProcessInfo {
  name: string
  /** empty when Windows does not let the user read it */
  path: string
  /** when it started, which tells it apart from a later process given the same pid; empty when unreadable */
  start?: string
}

export interface CheatEngineDeps {
  /** the bridge script the app carries, in `sandbox/cheat-engine/` */
  script: string
  bridge?: BridgeClient
  /** the name and executable path of a running process, or null when there is none */
  processInfo?(pid: number): Promise<ProcessInfo | null>
  /** whether a process is still running */
  alive?(pid: number): boolean
}

/** A running process's name and path, through PowerShell; null when no process has the id or this is not Windows. */
export function windowsProcessInfo(pid: number): Promise<ProcessInfo | null> {
  if (process.platform !== "win32") return Promise.resolve(null)
  const script = `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop; $s = try { $p.StartTime.ToFileTimeUtc() } catch { 0 }; [pscustomobject]@{ name = $p.ProcessName; path = "$($p.Path)"; start = "$s" } | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const p = JSON.parse(stdout) as { name?: unknown; path?: unknown; start?: unknown }
        const start = typeof p.start === "string" && p.start !== "0" ? p.start : ""
        resolve(typeof p.name === "string" ? { name: p.name, path: typeof p.path === "string" ? p.path : "", start } : null)
      } catch {
        resolve(null)
      }
    })
  })
}

/** Whether a process runs: a signal 0 that is refused for lack of rights still finds it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

const config = (c: Record<string, unknown>): CheatEngineConfig => CheatEngineConfigSchema.parse(c)
const autorun = (exe: string) => join(dirname(exe), "autorun")

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** A bridge answer that says it failed is the call's error. */
function unwrap(r: unknown): unknown {
  if (r && typeof r === "object" && (r as { success?: unknown }).success === false)
    throw new Error(String((r as { error?: unknown }).error ?? "Cheat Engine refused the call."))
  return r
}

export function cheatEngine(deps: CheatEngineDeps): HostIntegration {
  const bridge = deps.bridge ?? new BridgeClient({ path: BRIDGE_PIPE, timeoutMs: CALL_TIMEOUT_MS })
  const processInfo = deps.processInfo ?? windowsProcessInfo
  const alive = deps.alive ?? processAlive

  /** The bridge's version and Cheat Engine's, or why it did not answer. */
  const ping = async (): Promise<{ version: string; cheatEngine: string } | { error: string }> => {
    try {
      const r = (await bridge.call("ping", {}, PING_TIMEOUT_MS)) as { version?: unknown; cheat_engine?: unknown }
      return { version: String(r?.version ?? ""), cheatEngine: String(r?.cheat_engine ?? "unknown") }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  const checks = async (raw: Record<string, unknown>): Promise<IntegrationCheck[]> => {
    const c = config(raw)
    const out: IntegrationCheck[] = []
    const exe = c.executablePath
    const exeOk = !!exe && isFile(exe)
    out.push(
      exeOk
        ? { name: "Cheat Engine executable", ok: true, detail: exe }
        : {
            name: "Cheat Engine executable",
            ok: false,
            detail: exe ? `There is no file at ${exe}.` : "No path is set.",
            fix: "Enter the full path to Cheat Engine's executable, such as cheatengine-x86_64.exe in its install folder.",
          },
    )
    const installed = exeOk ? join(autorun(exe), BRIDGE_FILE) : ""
    const current = exeOk && isFile(installed) && readFileSync(installed).equals(readFileSync(deps.script))
    out.push(
      current
        ? { name: "Bridge installed", ok: true, detail: installed }
        : {
            name: "Bridge installed",
            ok: false,
            detail: !exeOk
              ? "Needs the executable's path first."
              : isFile(installed)
                ? `${installed} is not the bridge this app carries.`
                : `${BRIDGE_FILE} is not in ${autorun(exe)}.`,
            fix: "Install the bridge, then restart Cheat Engine.",
          },
    )
    const p = await ping()
    out.push(
      "error" in p
        ? { name: "Bridge answers", ok: false, detail: p.error, fix: "Open Cheat Engine; after installing the bridge, restart it so it loads." }
        : p.version !== BRIDGE_VERSION
          ? {
              name: "Bridge answers",
              ok: false,
              detail: `The bridge answers as ${p.version || "an unknown version"}, not ${BRIDGE_VERSION}.`,
              fix: "Install the bridge again and restart Cheat Engine.",
            }
          : { name: "Bridge answers", ok: true, detail: `Bridge ${p.version} in Cheat Engine ${p.cheatEngine}` },
    )
    return out
  }

  const connected = async () => {
    const p = await ping()
    return !("error" in p) && p.version === BRIDGE_VERSION
  }

  const describeTarget = async (_raw: Record<string, unknown>, target: unknown) => {
    const { pid } = ProcessTargetSchema.parse(target)
    const p = await processInfo(pid)
    if (!p) throw new Error(`No process with pid ${pid} is running.`)
    return `${p.name} (pid ${pid})${p.path ? ` — ${p.path}` : " — its executable path could not be read"}`
  }

  return {
    info: CHEAT_ENGINE_INFO,
    timeoutMs: CALL_TIMEOUT_MS,
    skill,
    checks,
    connected,
    catalog: async () => CHEAT_ENGINE_TOOLS,
    describeTarget,

    // The process as the user approved it: a pid Windows hands to another process later is another target (R3.4).
    async identify(_raw, target) {
      const { pid } = ProcessTargetSchema.parse(target)
      const p = await processInfo(pid)
      return p ? JSON.stringify([pid, p.name, p.path, p.start ?? ""]) : null
    },

    async call(_raw, tool, args) {
      if (tool === "status") {
        const p = await ping()
        return {
          connected: !("error" in p) && p.version === BRIDGE_VERSION,
          cheatEngineVersion: "error" in p ? null : p.cheatEngine,
          bridgeVersion: "error" in p ? null : p.version,
          ...("error" in p ? { error: p.error } : {}),
          tools: CHEAT_ENGINE_TOOLS.map((t) => t.name),
        }
      }
      const t = CHEAT_ENGINE_TOOLS.find((x) => x.name === tool)
      if (!t || t.target) throw new Error(`${tool} works on an approved process.`)
      const { method, params } = bridgeCall(tool, args)
      return unwrap(await bridge.call(method, params))
    },

    async session(_raw, target): Promise<IntegrationSession> {
      const { pid } = ProcessTargetSchema.parse(target)
      if (!alive(pid)) throw new Error(`The process with pid ${pid} is not running.`)
      // Only the approved process is ever opened (R3.3).
      const opened = unwrap(await bridge.call("open_process", { process_id_or_name: pid })) as { process_id?: unknown }
      if (opened.process_id !== pid) throw new Error(`Cheat Engine opened pid ${String(opened.process_id)}, not the approved pid ${pid}.`)
      let exited = false
      return {
        async call(tool, args) {
          // Once gone it stays gone, even if Windows hands the pid to another process (R3.4).
          if (exited || !alive(pid)) {
            exited = true
            throw new Error(`The approved process (pid ${pid}) has exited.`)
          }
          const { method, params } = bridgeCall(tool, args)
          // The check and the read go as one unit: no other session's open_process can land between them (R3.3).
          return bridge.exclusive(
            async (send) => {
              const now = (await send("get_opened_process_id")) as { success?: unknown; process_id?: unknown }
              if (now?.success === false || now?.process_id !== pid)
                throw new Error(
                  `Cheat Engine has ${now?.process_id ? `pid ${String(now.process_id)}` : "no process"} open, not the approved pid ${pid}; the call is refused. Open the approved process in Cheat Engine again, or start a new delegation.`,
                )
              return unwrap(await send(method, params))
            },
            CALL_TIMEOUT_MS,
            tool,
          )
        },
      }
    },

    async runAction(raw, action): Promise<IntegrationActionResult> {
      if (action !== "install-bridge") throw new Error(`Cheat Engine has no action ${action}.`)
      const c = config(raw)
      if (!c.executablePath || !isFile(c.executablePath))
        return { ok: false, message: "Set the path to Cheat Engine's executable first; the bridge goes into the autorun folder beside it." }
      const folder = autorun(c.executablePath)
      try {
        if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
        copyFileSync(deps.script, join(folder, BRIDGE_FILE))
        return { ok: true, message: `Installed the bridge in ${folder}. Restart Cheat Engine so it loads.` }
      } catch (e) {
        // Cheat Engine under Program Files needs an administrator to write there (R1.4).
        return {
          ok: false,
          message: `Could not write into ${folder}: ${(e as Error).message}. Copy the script into that folder by hand, as an administrator if Windows asks, then restart Cheat Engine.`,
          paths: [
            { label: "The bridge script", path: deps.script },
            { label: "Copy it into", path: folder },
          ],
        }
      }
    },
  }
}
