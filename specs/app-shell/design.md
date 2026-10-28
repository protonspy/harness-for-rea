# App shell — design

## What changes

Serves R1.1, R1.2, R1.3, R2.1, R2.2, R2.3, R2.4, R3.1, R3.2, R3.3, R4.1, R4.2.

The project skeleton is carried over from `study-lab` (electron-vite, one
`@shared` alias for main, preload and renderer) with the hardened window of the
MagnoTech desktop app (`janela.ts`). Tests run on Vitest with V8 coverage instead
of `node:test`, because the gate reads a coverage figure; `electron` is aliased
to a stub so main-process code runs under plain Node.

## Boundaries and contracts

`src/shared/api.ts` is the whole contract: one zod schema per method for its
arguments, the method names derived from that table, and the union of pushed
messages. The preload builds the bridge from the method names, so a method that is
not in the table does not exist in the renderer. The main process dispatches every
call through one `ipcMain.handle("api", …)` that checks the sender's frame URL
against the app's page, looks the method up, parses the arguments and only then
runs the handler.

```
renderer ── window.hfr.api.<method>(...args) ──▶ preload ── invoke("api", method, ...args) ──▶ dispatch
renderer ◀── window.hfr.onPush(fn) ── preload ◀── webContents.send("push", message) ──────── main
```

The OpenRouter key lives in the settings table as base64 of
`safeStorage.encryptString`; with encryption unavailable `saveKey` throws, unlike
`study-lab`, which fell back to base64 of the plain key.

`scripts/test-gate.mjs` runs `vitest run --coverage` with the JSON summary
reporter and prints the one line the gate reads, exiting with Vitest's status.

## Risks

- Coverage counts `src/main` and `src/shared` and the renderer's `lib/`; the
  Electron entry point and React views are exercised by running the app, not by
  the suite, so the figure says nothing about them.
