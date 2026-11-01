// The TUI's key store against the real OS keychain, run under Bun by tests/bun-core.test.ts (specs/tui R1.3): a key
// saved through the credentials layer is read back at the next start, nothing of it lands in the database, and a
// clear removes it from the keychain. A service of its own keeps the user's real entries untouched.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearKey, initKey, readKey, saveKey, useKeyStore } from "../../src/main/credentials"
import { getDb, openDb } from "../../src/main/db"
import { keychainKeyStore } from "../../tui/src/keys"

const service = `harness-for-rea-test-${process.pid}`
openDb(join(mkdtempSync(join(tmpdir(), "hfr-keys-")), "hfr.db"))
const store = keychainKeyStore(service)
useKeyStore(store)
await saveKey("sk-or-v1-keychaintest0001")
await initKey()
const afterRestart = readKey()
const inDb = JSON.stringify(getDb().prepare("SELECT * FROM settings").all()).includes("keychaintest")
const inKeychain = await store.read("openrouter.key")
await clearKey()
const afterClear = await store.read("openrouter.key")
console.log(JSON.stringify({ available: store.available(), afterRestart, inDb, inKeychain, afterClear }))
process.exit(0)
