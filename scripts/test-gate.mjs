// The test gate: run the suite with coverage, then print the one line `scc check` reads,
// {"total": N, "coverage": P}, and exit with the suite's own status.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const results = path.join(root, "coverage", "results.json")
const summary = path.join(root, "coverage", "coverage-summary.json")
rmSync(results, { force: true })

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs")
const run = spawnSync(process.execPath, [vitest, "run", "--coverage", "--reporter=default", "--reporter=json", `--outputFile.json=${results}`], {
  cwd: root,
  stdio: "inherit",
})

const total = existsSync(results) ? JSON.parse(readFileSync(results, "utf8")).numTotalTests : 0
const coverage = existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")).total.lines.pct : 0
console.log(JSON.stringify({ total, coverage }))
process.exit(run.status ?? 1)
