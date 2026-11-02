// One of two apps started together on one data folder, run under Bun by tests/bun-core.test.ts (specs/shared-data-folder
// R3.2, R4.1, R4.2): it opens the database, which migrates it once between them, gives the tasks from before projects a
// project each, once between them, and prepares the image only when no other app is preparing it — recording a build in
// builds.log, or waiting for the other app's.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { exclusive, openDb } from "../../src/main/db"
import { Locks } from "../../src/main/lock"
import { ProcessRegistry } from "../../src/main/processes"
import { ProjectStore } from "../../src/main/projects"

const [dataDir, app] = process.argv.slice(2) as [string, "desktop" | "tui"]
openDb(join(dataDir, "hfr.db"), { app, version: "test" })
const me = new ProcessRegistry(app, "test")
me.start()
const locks = new Locks(dataDir, me.me, me.holds)
const adopted = exclusive(() =>
  new ProjectStore(dataDir).adopt({ provider: "openrouter", model: "m/x", orchestratorEffort: "medium", specialistEffort: "medium" }),
)
let built = false
for (let i = 0; i < 200; i++) {
  if (locks.holder("images")) {
    await Bun.sleep(25)
    continue
  }
  const release = locks.take("images", () => "images")
  // Another app may have built while this one waited: the build is skipped once one is recorded.
  if (!(await Bun.file(join(dataDir, "builds.log")).exists())) {
    appendFileSync(join(dataDir, "builds.log"), `${app}\n`)
    built = true
    await Bun.sleep(500)
  }
  release()
  break
}
me.stop()
console.log(JSON.stringify({ app, adopted, built }))
process.exit(0)
