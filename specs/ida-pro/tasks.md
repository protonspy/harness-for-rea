# Ida pro — tasks

## 1 · The plugin and its catalog

- [x] 1.1 (Unit) Define the IDA Pro integration in `src/shared/idapro.ts`: its user-folder setting, its database target, its install action and its catalog with the orchestrator's defaults — R1.1, R2.4, R2.5, R3.1, R3.2
- [x] 1.2 (Unit) Derive `sandbox/ida-pro/` from upstream `c133c38` with its MIT notice and commit, keeping only the read-only profile's tools, served on its own local-only named pipe with `ping` and `get_database`, and answer any other method with `-32601` — R2.1, R2.2, R2.3, R2.6
  _Depends 1.1_
- [x] 1.3 (Unit) Hold the plugin's `@tool` functions equal to the catalog's tools in a test — R2.1, R2.2
  _Depends 1.2_
- [x] 1.4 (Unit) Let the pipe client name its engine in its errors — R3.4

## 2 · The integration

- [x] 2.1 (Unit) Check the installed plugin and its ping version, and answer `status` from them and the open database — R1.2, R2.4
  _Depends 1.4_
- [x] 2.2 (Unit) Install the plugin into IDA's user `plugins` folder, and on a write error return the plugin's path and the folder to copy it into — R1.3, R1.4
  _Depends 1.2_
- [x] 2.3 (TDD) Describe a database by input name, path and SHA-256, and refuse a call while IDA has another database open or none — R3.1, R3.3, R3.4
  _Depends 1.4_
- [x] 2.4 (Unit) Register the IDA Pro integration in the app's list and ship its folder — R1.1
  _Depends 2.1, 2.2, 2.3_

## 3 · The record

- [x] 3.1 (Unit) Add IDA Pro and the plugin to `docs/stack.md`, the plugin's term to `docs/glossary.md`, and the integration to the README — R2.3
