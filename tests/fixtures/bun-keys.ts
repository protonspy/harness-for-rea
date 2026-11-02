// The shared key store against the real OS keychain, run under Bun by tests/bun-core.test.ts (specs/shared-data-folder
// R5): a key the 0.1 TUI kept in `Bun.secrets` is moved into the shared store, a key saved through the credentials layer
// is read back at the next start, nothing of it lands in the database, and a key saved here is left for the Node side
// of the test to read, as the desktop app would. A service of its own keeps the user's real entries untouched.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearKey, initKey, moveKeys, readKey, saveKey, useKeyStore } from "../../src/main/credentials"
import { getDb, openDb } from "../../src/main/db"
import { keyringStore } from "../../src/main/keys"
import { bunSecretsKeyStore } from "../../tui/src/keys"

const service = process.argv[2] ?? `harness-for-rea-test-${process.pid}`
openDb(join(mkdtempSync(join(tmpdir(), "hfr-keys-")), "hfr.db"))
const former = bunSecretsKeyStore(service)
const store = keyringStore(service)
await former.write("deepseek.key", "sk-deepseek-formerstore01")
const moved = await moveKeys(former, store)
useKeyStore(store)
await saveKey("sk-or-v1-keychaintest0001")
await initKey()
const afterRestart = readKey()
const movedKey = readKey("deepseek")
const leftInFormer = await former.read("deepseek.key")
const inDb = JSON.stringify(getDb().prepare("SELECT * FROM settings").all()).includes("keychaintest")
const inKeychain = await store.read("openrouter.key")
await clearKey()
const afterClear = await store.read("openrouter.key")
// left for the Node process to read, as the desktop app reads what the TUI saved
await store.write("openrouter.key", "sk-or-v1-savedbythetui01")
console.log(JSON.stringify({ available: store.available(), moved, movedKey, leftInFormer, afterRestart, inDb, inKeychain, afterClear }))
process.exit(0)
