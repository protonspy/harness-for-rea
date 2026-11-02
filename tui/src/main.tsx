import { spawn } from "node:child_process"
import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { API_METHODS, type Api } from "../../src/shared/api"
import type { Push } from "../../src/shared/types"
import { startCore } from "../../src/main/core"
import { SchemaTooNew } from "../../src/main/db"
import { makeDispatcher } from "../../src/main/ipc"
import { keyringStore } from "../../src/main/keys"
import { defaultDataDir } from "../../src/main/lock"
import pkg from "../../package.json"
import { App } from "./app/App"
import type { AppState, Bus } from "./app/context"
import { browse } from "./app/pickers"
import { themeFor } from "./app/theme"
import { bunSecretsKeyStore } from "./keys"
import type { Platform } from "./lib/launch"
import { parseArgs, sandboxDirFor } from "./paths"

/*
  The TUI's entry (specs/tui-launch R1.1, R1.7, R2.5): the arguments answered before anything starts, the folder it
  is run in checked, then the core the desktop app runs — on the same data folder, beside it and other TUIs
  (adr:0024-share-the-data-folder-between-processes) — and the React shell on OpenTUI
  (adr:0023-build-the-tui-on-opentuis-react-layer). Every call goes through the same validating dispatcher as the
  desktop app's IPC.
*/

/** The TUI's own origin for the dispatcher's page check. */
const PAGE = "tui://local/"

const parsed = parseArgs(process.argv.slice(2), pkg.version)
if ("print" in parsed) {
  ;(parsed.code ? console.error : console.log)(parsed.print)
  process.exit(parsed.code)
}
const { args } = parsed

// The folder is checked before the core starts: a mistyped path opens nothing (R1.7).
const given = resolve(args.path ?? process.cwd())
if (!existsSync(given)) {
  console.error(`${given} does not exist.`)
  process.exit(1)
}
// The folder a link or junction leads to, so the data folder and broad folders are recognised however they are named.
const folder = realpathSync.native(given)
if (!statSync(folder).isDirectory()) {
  console.error(`${folder} is a file. Run harness-for-rea in its folder, or create a project on the file with /new.`)
  process.exit(2)
}

const sandboxDir = sandboxDirFor({ env: process.env, execPath: process.execPath, moduleDir: import.meta.dir, exists: existsSync })
if (!sandboxDir) {
  console.error("The sandbox sources (specialist/Dockerfile) were not found; set HFR_SANDBOX_DIR to the folder holding them.")
  process.exit(1)
}

const dataDir = process.env.HFR_DATA_DIR ?? defaultDataDir()
const listeners = new Set<(p: Push) => void>()
const bus: Bus = {
  on: (fn) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
}
let app: AppState | null = null

/** Opens an Anthropic sign-in page in the user's browser; the core checked the address first. */
function openBrowser(url: string): Promise<void> {
  const [cmd, argv] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]
  return new Promise((done) => {
    const p = spawn(cmd, argv, { stdio: "ignore", detached: true })
    p.on("error", () => done())
    p.unref()
    done()
  })
}

let core: Awaited<ReturnType<typeof startCore>>
try {
  core = await startCore({
    app: "tui",
    version: pkg.version,
    dataDir,
    sandboxDir,
    push: (p) => {
      for (const fn of listeners) fn(p)
    },
    // The shared keychain both apps read; the 0.1 TUI's `Bun.secrets` keys are moved into it (specs/shared-data-folder R5).
    keys: keyringStore(),
    formerKeys: bunSecretsKeyStore(),
    // The terminal's browser stands in for the desktop app's file dialogs (specs/tui-panels R2.3).
    pickFolder: () => (app ? browse(app, "folder", folder) : Promise.resolve(null)),
    pickTarget: (kind) => (app ? browse(app, kind, folder) : Promise.resolve(null)),
    openExternal: openBrowser,
  })
} catch (e) {
  if (!(e instanceof SchemaTooNew)) throw e
  console.error(e.message)
  process.exit(1)
}

const dispatch = makeDispatcher(core.handlers, () => PAGE)
const api = Object.fromEntries(API_METHODS.map((m) => [m, (...a: unknown[]) => dispatch(PAGE, m, a)])) as unknown as Api

const renderer = await createCliRenderer({ exitOnCtrlC: false })
let quitting = false
const quit = () => {
  if (quitting) return
  quitting = true
  renderer.destroy()
  void core.shutdown().finally(() => process.exit(0))
}
process.on("SIGTERM", quit)

createRoot(renderer).render(
  <App
    api={api}
    bus={bus}
    theme={themeFor(args.theme, process.env)}
    where={{ folder, platform: process.platform as Platform, home: homedir(), dataDir, env: process.env }}
    args={{ continue: args.continue, resume: args.resume }}
    quit={quit}
    onReady={(a) => (app = a)}
  />,
)
