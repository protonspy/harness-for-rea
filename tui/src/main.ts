import { existsSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { API_METHODS, type Api } from "../../src/shared/api"
import type { Push } from "../../src/shared/types"
import { startCore } from "../../src/main/core"
import { makeDispatcher } from "../../src/main/ipc"
import { SchemaTooNew } from "../../src/main/db"
import { keyringStore } from "../../src/main/keys"
import { defaultDataDir } from "../../src/main/lock"
import { App } from "./app"
import pkg from "../../package.json"
import { bunSecretsKeyStore } from "./keys"
import { answerFlags, sandboxDirFor } from "./paths"

/*
  The TUI's entry (specs/tui R1): the core the desktop app runs, on its data folder, with the keys in the OS
  keychain. Every call goes through the same validating dispatcher as the desktop app's IPC, so the terminal's
  input meets the same schemas. While the desktop app holds the data folder, it says so and exits.
*/

/** The TUI's own origin for the dispatcher's page check. */
const PAGE = "tui://local/"

// Flags are answered before the core starts, so `--version` works where the data folder is taken (specs/release R1.4).
const flags = answerFlags(process.argv.slice(2), pkg.version)
if (flags !== null) {
  console.log(flags)
  process.exit(0)
}

const sandboxDir = sandboxDirFor({ env: process.env, execPath: process.execPath, moduleDir: import.meta.dir, exists: existsSync })
if (!sandboxDir) {
  console.error("The sandbox sources (specialist/Dockerfile) were not found; set HFR_SANDBOX_DIR to the folder holding them.")
  process.exit(1)
}

let app: App | null = null
const pending: Push[] = []

let core: Awaited<ReturnType<typeof startCore>>
try {
  core = await startCore({
    app: "tui",
    version: pkg.version,
    dataDir: process.env.HFR_DATA_DIR ?? defaultDataDir(),
    sandboxDir,
    push: (p) => (app ? app.onPush(p) : pending.push(p)),
    keys: keyringStore(),
    formerKeys: bunSecretsKeyStore(),
  })
} catch (e) {
  if (!(e instanceof SchemaTooNew)) throw e
  console.error(e.message)
  process.exit(1)
}

const dispatch = makeDispatcher(core.handlers, () => PAGE)
const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => dispatch(PAGE, m, args)])) as unknown as Api

const renderer = await createCliRenderer({ exitOnCtrlC: false })
let quitting = false
const quit = () => {
  if (quitting) return
  quitting = true
  renderer.destroy()
  void core.shutdown().finally(() => process.exit(0))
}
app = new App(renderer, api, quit)
for (const p of pending.splice(0)) app.onPush(p)
await app.start()
