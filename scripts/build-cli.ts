// Builds the CLI/TUI with Bun (specs/release R1.3, R2.4):
//
//   bun scripts/build-cli.ts package                 the npm package in tui/: dist/main.js, sandbox/, the version
//   bun scripts/build-cli.ts binary <target> <out>   a standalone binary for a `--compile` target such as
//                                                    bun-windows-x64, bun-darwin-arm64 or bun-darwin-x64, with
//                                                    sandbox/ beside it in <out>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BunPlugin } from "bun"
import { CLI_SANDBOX } from "./cli-sandbox"

const root = join(import.meta.dir, "..")
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version
const entry = join(root, "tui", "src", "main.tsx")

/** Vite's `?raw` imports — the specialist's operating guide — as the file's text, which Bun's bundler does not do itself. */
const raw: BunPlugin = {
  name: "raw",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(dirname(a.importer), a.path.slice(0, -"?raw".length)), namespace: "raw" }))
    build.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }))
  },
}

/** Only the parts of sandbox/ the CLI reads at run time (scripts/cli-sandbox.ts). */
function copySandbox(to: string) {
  rmSync(join(to, "sandbox"), { recursive: true, force: true })
  for (const part of CLI_SANDBOX) cpSync(join(root, "sandbox", part), join(to, "sandbox", part), { recursive: true })
}

/**
  OpenTUI React's devtools and their WebSocket, imported only when its DEV switch is on, which the TUI never sets:
  built as empty modules rather than installed (adr:0023-build-the-tui-on-opentuis-react-layer).
*/
const devtools: BunPlugin = {
  name: "devtools",
  setup(build) {
    build.onResolve({ filter: /^(react-devtools-core|ws)$/ }, (a) => ({ path: a.path, namespace: "devtools" }))
    build.onLoad({ filter: /.*/, namespace: "devtools" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} }", loader: "js" }))
  },
}

function check(r: { success: boolean; logs: unknown[] }) {
  if (r.success) return
  for (const l of r.logs) console.error(l)
  process.exit(1)
}

const [mode, target, out] = process.argv.slice(2)
if (mode === "package") {
  const tui = join(root, "tui")
  rmSync(join(tui, "dist"), { recursive: true, force: true })
  // OpenTUI stays a dependency: npm installs its library for the user's platform.
  check(
    await Bun.build({
      entrypoints: [entry],
      target: "bun",
      outdir: join(tui, "dist"),
      naming: "main.js",
      external: ["@opentui/core", "@napi-rs/keyring"],
      plugins: [raw, devtools],
    }),
  )
  copySandbox(tui)
  const manifest = JSON.parse(readFileSync(join(tui, "package.json"), "utf8"))
  writeFileSync(join(tui, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  console.log(`harness-for-rea ${version}: tui/ is ready to pack`)
} else if (mode === "binary" && target && out) {
  mkdirSync(out, { recursive: true })
  const outfile = join(out, target.includes("windows") ? "harness-for-rea.exe" : "harness-for-rea")
  check(await Bun.build({ entrypoints: [entry], compile: { target: target as Bun.Build.CompileTarget, outfile }, plugins: [raw, devtools] }))
  copySandbox(out)
  console.log(`${outfile} built for ${target}`)
} else {
  console.error("Usage: bun scripts/build-cli.ts package | binary <target> <out dir>")
  process.exit(2)
}
