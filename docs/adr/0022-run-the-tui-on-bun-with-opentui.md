---
status: accepted
---

# 0022 · Run the TUI on Bun with OpenTUI

## Context

plans/finish-the-harness asks for a terminal UI beside the Electron app, on the same core: the event
log on `node:sqlite`, the orchestrator on DeepAgents and LangGraph, the delegations to the
specialist in Docker. The renderer the plan names, OpenTUI, runs on Bun: its core is a native
library loaded through `bun:ffi`. Whether the core runs on Bun was the open question — `node:sqlite`
is a Node built-in, and the main process relies on electron-vite for the `@shared/*` alias and for
Vite's `?raw` imports.

The spike (plan task 1.7, `tests/bun-core.test.ts`) ran one task with a delegation end to end under
Bun 1.4.4 on Windows: `node:sqlite`, the event log, DeepAgents and LangGraph against a scripted
OpenRouter, and the fake specialist, reaching `awaiting-user` with every event the Node suite sees.
Bun resolved the alias from the root `tsconfig.json` and the `?raw` import on its own. OpenTUI
0.8.1 rendered under Bun on Windows. The only Electron-only modules in `src/main` are `index.ts` and
`credentials.ts` (`safeStorage`).

## Decision

The TUI runs on Bun and renders with OpenTUI (`@opentui/core`), importing the core from `src/main`
and `src/shared` as it is, with Electron's parts — the key store and the transport between core and
view — behind interfaces the desktop app and the TUI each implement (plan task 1.8). The root
`tsconfig.json` carries the `@shared/*` path so Bun resolves it.

Rejected:

- Node with a Node terminal renderer (Ink, blessed): the core would run unchanged, but the plan
  names OpenTUI, and the spike removed the reason to give it up.
- A second core written for the terminal: two copies of the orchestrator and the event log would
  drift.

## Consequences

- Bun becomes a runtime of the project, beside Node and Electron's Node: a change to the core has
  to keep working under both, and `tests/bun-core.test.ts` (`HFR_BUN=1`) is the check.
- The TUI reaches users through Bun: the npm package and the release binaries carry or fetch it
  (specs/release).
- OpenTUI is young (0.x) and loads a native library per platform; an upgrade is a tested change.
- The key store needs an implementation outside Electron: the OS keychain, through the TUI's own
  dependency, where the desktop app keeps `safeStorage`.
