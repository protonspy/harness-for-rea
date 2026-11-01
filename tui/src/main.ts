import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { API_METHODS, type Api } from "../../src/shared/api"
import type { Push } from "../../src/shared/types"
import { startCore } from "../../src/main/core"
import { makeDispatcher } from "../../src/main/ipc"
import { DataFolderBusy, defaultDataDir } from "../../src/main/lock"
import { App } from "./app"
import { keychainKeyStore } from "./keys"

/*
  The TUI's entry (specs/tui R1): the core the desktop app runs, on its data folder, with the keys in the OS
  keychain. Every call goes through the same validating dispatcher as the desktop app's IPC, so the terminal's
  input meets the same schemas. While the desktop app holds the data folder, it says so and exits.
*/

/** The TUI's own origin for the dispatcher's page check. */
const PAGE = "tui://local/"

/** The sandbox sources: next to the package's bundle, or the repository's when run from source. */
function sandboxDir(): string {
  return process.env.HFR_SANDBOX_DIR ?? join(import.meta.dir, "..", "..", "sandbox")
}

let app: App | null = null
const pending: Push[] = []

let core: Awaited<ReturnType<typeof startCore>>
try {
  core = await startCore({
    app: "tui",
    dataDir: process.env.HFR_DATA_DIR ?? defaultDataDir(),
    sandboxDir: sandboxDir(),
    push: (p) => (app ? app.onPush(p) : pending.push(p)),
    keys: keychainKeyStore(),
  })
} catch (e) {
  if (!(e instanceof DataFolderBusy)) throw e
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
