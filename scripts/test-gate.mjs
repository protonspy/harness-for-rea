// The test gate: run the suite with coverage, then print the one line `scc check` reads,
// {"total": N, "coverage": P}, and exit with the suite's own status.
//
// With HFR_BUN=1 (CI sets it), the tests that need Bun count too (plans/tui-revamp 1.5): Vitest runs the Bun core
// tests in tests/bun-core.test.ts, and `bun test tui/test` runs the TUI's screen tests on OpenTUI's test renderer.
// Bun is the one on PATH, or 1.4.4 fetched through npx.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const results = path.join(root, "coverage", "results.json")
const summary = path.join(root, "coverage", "coverage-summary.json")
const bunResults = path.join(root, "coverage", "bun-results.xml")
rmSync(results, { force: true })
rmSync(bunResults, { force: true })

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs")
const run = spawnSync(process.execPath, [vitest, "run", "--coverage", "--reporter=default", "--reporter=json", `--outputFile.json=${results}`], {
  cwd: root,
  stdio: "inherit",
})

let total = existsSync(results) ? JSON.parse(readFileSync(results, "utf8")).numTotalTests : 0
let status = run.status ?? 1

if (process.env.HFR_BUN) {
  const shell = process.platform === "win32"
  const onPath = spawnSync("bun", ["--version"], { encoding: "utf8", shell }).status === 0
  const [cmd, pre] = onPath ? ["bun", []] : ["npx", ["-y", "bun@1.4.4"]]
  const screens = spawnSync(cmd, [...pre, "test", "tui/test", "--reporter=junit", `--reporter-outfile=${bunResults}`], { cwd: root, stdio: "inherit", shell })
  const xml = existsSync(bunResults) ? readFileSync(bunResults, "utf8") : ""
  const counted = Number(/<testsuites[^>]*\btests="(\d+)"/.exec(xml)?.[1] ?? 0)
  total += counted
  // No screen test counted is a renderer that did not start: the gate fails rather than passing on Vitest alone.
  if (screens.status !== 0 || counted === 0) status = status || screens.status || 1
}

const coverage = existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")).total.lines.pct : 0
console.log(JSON.stringify({ total, coverage }))
process.exit(status)
