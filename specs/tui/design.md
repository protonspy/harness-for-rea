# TUI — design

## What changes

Serves R1.1–R3.5, under adr:0022-run-the-tui-on-bun-with-opentui.

- `tui/src/main.ts` — the entry: `startCore({ app: "tui", dataDir: defaultDataDir(), … })` with the
  TUI's key store and a push that feeds the view (R1.1). `DataFolderBusy` is printed and the
  process exits with 1 before anything else (R1.2).
- `tui/src/keys.ts` — the `KeyStore` on `Bun.secrets`, service `harness-for-rea`, one entry per
  provider slot, so the key lives in the OS keychain (Credential Manager, Keychain, libsecret) and
  nowhere in the data folder (R1.3).
- `tui/src/view.ts` — pure functions from the core's data to lines: the setup steps (R2.1), a
  project and its tasks (R3.1, R3.2), the timeline from `src/renderer/src/lib/timeline.ts` (R3.3),
  and a waiting question with how to answer it (R3.4). Tested under Vitest like `lib/`.
- `tui/src/app.ts` — the screens on OpenTUI: setup, projects, project, task. A list (`Select`), a
  scrolling body (`ScrollBox`) and one input line (`Input`) per screen; the input's meaning follows
  the screen and what waits: a command (`/new`, `/stop`, `/cancel`, `/back`), an answer, or a
  message (R2.2, R3.1–R3.5). Escape goes back; Ctrl+C quits through `core.shutdown()`.
- `tui/package.json`, `tui/bin/hfr.mjs` — the CLI package (specs/release): the bundle built by
  `bun build`, `@opentui/core` and `bun` as dependencies, and a Node shim that starts the bundle
  with the `bun` the package installed.

## Alternatives considered

- Talking to a running desktop app over a socket instead of running the core: two processes on one
  data folder is what the lock forbids, and the TUI must work where no desktop runs.
- React bindings for OpenTUI: a second UI framework in the terminal for four screens; the
  imperative core API is enough.
