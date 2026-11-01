#!/usr/bin/env node
// The npm command of Harness for REA's terminal UI (specs/release R2.4): runs the bundled TUI on the Bun this package
// depends on — the `bun` package's binary, or its platform package's when npm skipped `bun`'s install script — with
// the sandbox sources the package carries.
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, "..")
const require = createRequire(import.meta.url)

const PLATFORM = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform]
const ARCH = { x64: "x64", arm64: "aarch64" }[process.arch]

/** A real binary, not the placeholder `bun` leaves before its install script ran. */
const real = (p) => existsSync(p) && statSync(p).size > 1024 * 1024

function bunBinary() {
  const candidates = []
  try {
    const dir = dirname(require.resolve("bun/package.json"))
    candidates.push(join(dir, "bin", "bun.exe"), join(dir, "bin", "bun"))
  } catch {
    // not installed: the platform package may still be
  }
  for (const variant of ["", "-baseline"]) {
    try {
      const dir = dirname(require.resolve(`@oven/bun-${PLATFORM}-${ARCH}${variant}/package.json`))
      candidates.push(join(dir, "bin", "bun.exe"), join(dir, "bin", "bun"))
    } catch {
      // that variant is not installed
    }
  }
  return candidates.find(real)
}

const bun = bunBinary()
if (!bun) {
  console.error("harness-for-rea: no Bun binary was found in this package's dependencies; reinstall it with npm install -g harness-for-rea.")
  process.exit(1)
}
const r = spawnSync(bun, [join(pkg, "dist", "main.js"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, HFR_SANDBOX_DIR: process.env.HFR_SANDBOX_DIR ?? join(pkg, "sandbox") },
})
process.exit(r.status ?? 1)
