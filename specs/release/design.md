# Release — design

## What changes

Serves R1.1–R2.4, under adr:0022-run-the-tui-on-bun-with-opentui.

- `.github/workflows/release.yml` — `workflow_dispatch` only, every job guarded by
  `github.ref == 'refs/heads/main'` (R1.1). A `check` job reads the version from `package.json` and
  fails when `v<version>` is a tag or `harness-for-rea@<version>` is on npm (R2.1). A `windows`
  job (windows-latest) and a `macos` job (macos-latest, arm64) build the desktop app with
  electron-builder, unsigned (R1.2), and the CLI with `bun build --compile` for their platforms —
  macOS x64 cross-compiled with OpenTUI's x64 library installed for it — each archived with
  the parts of `sandbox/` the CLI reads (R1.3), and run the native binary with `--version` (R1.4). A `publish` job
  creates the release with `gh release create` and the artifacts (R2.2), then `npm publish` of
  `tui/` with `NODE_AUTH_TOKEN` from `NPM_TOKEN` (R2.3).
- `electron-builder.yml` — `mac` targets `dmg` for arm64 and x64 with `identity: null`.
- `tui/package.json`, `tui/bin/harness-for-rea.mjs`, `scripts/build-cli.mjs` — the npm package
  `harness-for-rea`: the TUI bundled by `bun build --target bun` with `@opentui/core` left to npm
  for its per-platform library, the parts of `sandbox/` named in `scripts/cli-sandbox.ts` copied
  in — `specialist`, the integrations' `mcp` server and Cheat Engine's `cheat-engine` bridge, each a
  folder the core joins onto its sandbox folder, which a test holds to that list — the version taken from the root
  `package.json`. The bin is a Node shim that runs the bundle on the `bun` dependency's binary, or
  on its `@oven/bun-*` platform package when npm skipped `bun`'s install script (R2.4).
- `tui/src/main.ts` — `--version` and `--help` answer before the core starts; the sandbox sources
  are found from `HFR_SANDBOX_DIR`, next to a compiled binary, or in the repository.

## Data

The CLI archive per platform: `harness-for-rea-cli-<version>-<windows-x64|macos-arm64|macos-x64>`
holding the binary (`harness-for-rea` or `.exe`) and `sandbox/` with `specialist/`, `mcp/` and
`cheat-engine/`.
