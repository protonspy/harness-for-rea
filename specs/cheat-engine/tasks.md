# Cheat engine — tasks

## 1 · The bridge and its catalog

- [x] 1.1 (Unit) Define the Cheat Engine integration in `src/shared/cheatengine.ts`: its executable-path setting, its process target, its install action and its catalog with the orchestrator's defaults — R1.1, R2.4, R2.5, R3.1, R3.2
- [x] 1.2 (Unit) Derive `sandbox/cheat-engine/hfr-bridge.lua` from upstream `6bd7ce90` with its MIT notice and commit, on its own pipe, keeping only the catalog's handlers plus `ping`, `open_process` and `get_opened_process_id`, and answer any other method with `-32601` — R2.1, R2.2, R2.3
  _Depends 1.1_
- [x] 1.3 (Unit) Hold the Lua's `commandHandlers` keys equal to the catalog's methods in a test — R2.1, R2.2
  _Depends 1.2_
- [x] 1.4 (Unit) Write the pipe client with the bridge's framing, one call in flight and a timeout per call, tested against a fake bridge on a local socket — R1.2, R2.4
  _Depends 1.1_

## 2 · The integration

- [x] 2.1 (Unit) Check the executable, the bridge in `autorun` and its ping version, and answer `status` from them — R1.2, R2.4
  _Depends 1.4_
- [x] 2.2 (Unit) Install the bridge into Cheat Engine's `autorun` folder, and on a write error return the script's path and the folder to copy it into — R1.3, R1.4
  _Depends 1.2_
- [x] 2.3 (TDD) Open only the approved PID in a session, describe it by name, PID and executable path, and refuse a call while the bridge's opened process is another or after the process exits — R3.1, R3.3, R3.4
  _Depends 1.4_
- [x] 2.4 (Unit) Register the Cheat Engine integration in the app's list — R1.1
  _Depends 2.1, 2.2, 2.3_

## 3 · The record

- [x] 3.1 (Unit) Add Cheat Engine and the bridge to `docs/stack.md` and the bridge's term to `docs/glossary.md` — R2.3
