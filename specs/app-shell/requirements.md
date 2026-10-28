---
autonomy: auto
ci: wait
branch: feat/harness-for-rea
delivery: in-progress
---

# App shell — requirements

## Purpose

The Electron skeleton every other feature runs in: a window the renderer cannot
escape from, one typed and validated IPC contract between renderer and main, a
credential store that never writes the OpenRouter key in plain text, and the
build, format, lint and test commands the delivery gate runs.

## R1 · Window

- **R1.1** The app shell shall create its window with context isolation, the renderer sandbox, web security on, and Node integration and web views off.
- **R1.2** If the renderer navigates away from the app's page or opens a new window, then the app shell shall block it.
- **R1.3** The app shell shall load the renderer under a Content Security Policy that allows scripts only from the app itself.

## R2 · IPC

- **R2.1** The app shell shall expose to the renderer only the methods named in the shared API contract, through the preload bridge.
- **R2.2** When the renderer calls a method, the app shell shall validate its arguments against that method's schema before running it.
- **R2.3** If a call names an unknown method, fails validation, or comes from a frame other than the app's page, then the app shell shall reject it with an error and not run it.
- **R2.4** When the main process has a new event or state change, the app shell shall push it to the renderer as an incremental message.

## R3 · Credentials

- **R3.1** The app shell shall store the OpenRouter API key encrypted with Electron's `safeStorage`.
- **R3.2** If `safeStorage` encryption is unavailable, then the app shell shall refuse to store the key and report why, without writing it in plain text.
- **R3.3** The app shell shall never return the stored key to the renderer, only whether one is set and a masked hint.

## R4 · Delivery gate

- **R4.1** The app shell shall provide build, format check, lint and test commands, the test command printing `{"total": N, "coverage": P}` and keeping the suite's exit status.
- **R4.2** When a branch is pushed, the CI workflow shall run the build, format check, lint and test on Windows.

## Out of scope

- Auto-update and code signing of the installer.
