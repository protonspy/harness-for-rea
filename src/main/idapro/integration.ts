import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import {
  DatabaseTargetSchema,
  IDA_PRO_INFO,
  IDA_PRO_TOOLS,
  IdaProConfigSchema,
  PLUGIN_ENTRY,
  PLUGIN_PACKAGE,
  PLUGIN_PIPE,
  PLUGIN_VERSION,
} from "@shared/idapro"
import type { IntegrationActionResult, IntegrationCheck } from "@shared/integrations"
import { BridgeClient } from "../cheatengine/pipe"
import type { HostIntegration, IntegrationSession } from "../integrations/registry"

/*
  The host side of the IDA Pro integration (specs/ida-pro): its checks, the plugin's install, `status`, what an
  approval shows of a database, and the session on the approved database, which refuses a call while IDA has
  another open (R3.3).
*/

/** One call's longest wait: upstream lets analyze_component run 180 s inside IDA. */
export const CALL_TIMEOUT_MS = 240_000
const PING_TIMEOUT_MS = 3_000
const DATABASE_TIMEOUT_MS = 30_000

export interface IdaProDeps {
  /** the app's `sandbox/ida-pro/` folder, holding the plugin's entry and package */
  pluginDir: string
  bridge?: BridgeClient
  /** %APPDATA%, where IDA's default user folder lives */
  appData?: string
}

/** The open database as the plugin reports it. */
export interface Database {
  input_name: string
  input_path: string
  idb_path: string
  sha256: string
}

/** IDA's user folder: the setting, else %APPDATA%\Hex-Rays\IDA Pro (R1.1). */
export function userDir(raw: Record<string, unknown>, appData = process.env.APPDATA ?? ""): string {
  const { userDir: dir } = IdaProConfigSchema.parse(raw)
  return dir || (appData ? join(appData, "Hex-Rays", "IDA Pro") : "")
}

/** Every file of the plugin, relative to its folder: the entry and the package, never Python's caches. */
export function pluginFiles(pluginDir: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "__pycache__" ? [] : walk(join(dir, e.name))) : [relative(pluginDir, join(dir, e.name))],
    )
  return [PLUGIN_ENTRY, ...walk(join(pluginDir, PLUGIN_PACKAGE))]
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** A Windows or POSIX path's last part. */
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? ""

const describe = (d: Database) => `${d.input_name || "an unnamed input"} — ${d.idb_path || "an unsaved database"} (sha256 ${d.sha256})`

export function idaPro(deps: IdaProDeps): HostIntegration {
  const bridge = deps.bridge ?? new BridgeClient({ path: PLUGIN_PIPE, timeoutMs: CALL_TIMEOUT_MS, engine: "IDA Pro", peer: "The IDA Pro plugin" })
  const folder = (raw: Record<string, unknown>) => userDir(raw, deps.appData)

  /** The plugin's version, IDA's and Python's, or why it did not answer. */
  const ping = async (): Promise<{ version: string; ida: string; python: string } | { error: string }> => {
    try {
      const r = (await bridge.call("ping", {}, PING_TIMEOUT_MS)) as { version?: unknown; ida?: unknown; python?: unknown }
      return { version: String(r?.version ?? ""), ida: String(r?.ida ?? "unknown"), python: String(r?.python ?? "unknown") }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  const database = async (send?: (method: string) => Promise<unknown>): Promise<Database> => {
    const r = (await (send ? send("get_database") : bridge.call("get_database", {}, DATABASE_TIMEOUT_MS))) as Partial<Database> | null
    return {
      input_name: String(r?.input_name ?? ""),
      input_path: String(r?.input_path ?? ""),
      idb_path: String(r?.idb_path ?? ""),
      sha256: String(r?.sha256 ?? "").toLowerCase(),
    }
  }

  /** The open database when it is the approved one; otherwise why not (R3.3). */
  const approved = async (sha256: string, send?: (method: string) => Promise<unknown>, idbPath?: string): Promise<Database> => {
    const d = await database(send)
    if (d.sha256 !== sha256 || (idbPath !== undefined && d.idb_path !== idbPath))
      throw new Error(
        d.sha256
          ? `IDA Pro has ${describe(d)} open, not the approved database (sha256 ${sha256}); the call is refused. Open the approved database in IDA again, or start a new delegation.`
          : `IDA Pro's database has no input file hash, so it cannot be the approved database (sha256 ${sha256}).`,
      )
    return d
  }

  const checks = async (raw: Record<string, unknown>): Promise<IntegrationCheck[]> => {
    const dir = folder(raw)
    const plugins = dir ? join(dir, "plugins") : ""
    const files = pluginFiles(deps.pluginDir)
    const stale = plugins
      ? files.filter((f) => !isFile(join(plugins, f)) || !readFileSync(join(plugins, f)).equals(readFileSync(join(deps.pluginDir, f))))
      : files
    const out: IntegrationCheck[] = [
      !plugins
        ? {
            name: "Plugin installed",
            ok: false,
            detail: "IDA's user folder is not set and %APPDATA% is unknown.",
            fix: "Enter IDA's user folder, such as %APPDATA%\\Hex-Rays\\IDA Pro.",
          }
        : stale.length
          ? {
              name: "Plugin installed",
              ok: false,
              detail: isFile(join(plugins, PLUGIN_ENTRY))
                ? `${plugins} does not hold the plugin this app carries (${stale.length} file${stale.length === 1 ? "" : "s"} differ).`
                : `${PLUGIN_ENTRY} is not in ${plugins}.`,
              fix: "Install the plugin, then reopen the database in IDA.",
            }
          : { name: "Plugin installed", ok: true, detail: plugins },
    ]
    const p = await ping()
    out.push(
      "error" in p
        ? {
            name: "Plugin answers",
            ok: false,
            detail: p.error,
            fix: "Open IDA Pro with a database; after installing the plugin, reopen the database so it loads.",
          }
        : p.version !== PLUGIN_VERSION
          ? {
              name: "Plugin answers",
              ok: false,
              detail: `The plugin answers as ${p.version || "an unknown version"}, not ${PLUGIN_VERSION}.`,
              fix: "Install the plugin again and reopen the database in IDA.",
            }
          : { name: "Plugin answers", ok: true, detail: `Plugin ${p.version} in IDA ${p.ida}, Python ${p.python}` },
    )
    return out
  }

  return {
    info: IDA_PRO_INFO,
    timeoutMs: CALL_TIMEOUT_MS,
    checks,
    async connected() {
      const p = await ping()
      return !("error" in p) && p.version === PLUGIN_VERSION
    },
    catalog: async () => IDA_PRO_TOOLS,

    async describeTarget(_raw, target) {
      const { sha256 } = DatabaseTargetSchema.parse(target)
      return describe(await approved(sha256))
    },

    // The database as the user approved it: the same input in another database is another target.
    async identify(_raw, target) {
      const { sha256 } = DatabaseTargetSchema.parse(target)
      const d = await database().catch(() => null)
      return d && d.sha256 === sha256 ? JSON.stringify([d.sha256, d.idb_path]) : null
    },

    async call(_raw, tool, args) {
      if (tool === "status") {
        const p = await ping()
        const d = "error" in p ? null : await database().catch(() => null)
        return {
          connected: !("error" in p) && p.version === PLUGIN_VERSION,
          idaVersion: "error" in p ? null : p.ida,
          pythonVersion: "error" in p ? null : p.python,
          pluginVersion: "error" in p ? null : p.version,
          ...("error" in p ? { error: p.error } : {}),
          // File names, not paths: a path names the user's account, and status goes to the orchestrator's provider.
          database: d && d.sha256 ? { input_name: d.input_name, idb_name: fileName(d.idb_path), sha256: d.sha256 } : null,
          tools: IDA_PRO_TOOLS.map((t) => t.name),
        }
      }
      const t = IDA_PRO_TOOLS.find((x) => x.name === tool)
      if (!t || t.target) throw new Error(`${tool} works on an approved database.`)
      return bridge.call(tool, args)
    },

    async session(_raw, target): Promise<IntegrationSession> {
      const { sha256 } = DatabaseTargetSchema.parse(target)
      // The database the session opened on: the same input in another database is not it.
      const { idb_path } = await approved(sha256)
      return {
        // The check and the call go as one unit: nothing reaches the plugin between them (R3.3).
        call: (tool, args) =>
          bridge.exclusive(
            async (send) => {
              await approved(sha256, (m) => send(m), idb_path)
              return send(tool, args)
            },
            CALL_TIMEOUT_MS,
            tool,
          ),
      }
    },

    async runAction(raw, action): Promise<IntegrationActionResult> {
      if (action !== "install-plugin") throw new Error(`IDA Pro has no action ${action}.`)
      const dir = folder(raw)
      if (!dir) return { ok: false, message: "Set IDA's user folder first; the plugin goes into its plugins folder." }
      const plugins = join(dir, "plugins")
      try {
        for (const f of pluginFiles(deps.pluginDir)) {
          mkdirSync(dirname(join(plugins, f)), { recursive: true })
          copyFileSync(join(deps.pluginDir, f), join(plugins, f))
        }
        return { ok: true, message: `Installed the plugin in ${plugins}. Reopen the database in IDA so it loads.` }
      } catch (e) {
        // A user folder IDA's own setup locked, or one under Program Files (R1.4).
        return {
          ok: false,
          message: `Could not write into ${plugins}: ${(e as Error).message}. Copy ${PLUGIN_ENTRY} and the ${PLUGIN_PACKAGE} folder into that folder by hand, then reopen the database in IDA.`,
          paths: [
            { label: "The plugin", path: deps.pluginDir },
            { label: "Copy it into", path: plugins },
          ],
        }
      }
    },
  }
}
