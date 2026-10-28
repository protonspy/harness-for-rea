# App shell — tasks

## 1 · Toolchain

- [x] 1.1 (Unit) Scaffold `package.json`, electron-vite, TypeScript, Vitest with V8 coverage, oxlint, Prettier and `scripts/test-gate.mjs` — R4.1
- [x] 1.2 (Unit) Add the GitHub Actions workflow running build, format check, lint and test on `windows-latest` — R4.2
  _Depends 1.1_

## 2 · Window and IPC

- [x] 2.1 (Unit) Build the window preferences, the navigation and window-open lock, and the Content Security Policy — R1.1, R1.2, R1.3
  _Depends 1.1_
- [x] 2.2 (Unit) Write the shared API contract with a zod schema per method, the validating dispatcher, the preload bridge and the push channel — R2.1, R2.2, R2.3, R2.4
  _Depends 1.1_

## 3 · Credentials

- [x] 3.1 (Unit) Store, read and clear the OpenRouter key through `safeStorage`, refusing when encryption is unavailable and exposing only a masked hint — R3.1, R3.2, R3.3
  _Depends 2.2_
