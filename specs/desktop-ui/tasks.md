# Desktop UI — tasks

## 1 · Foundation

- [x] 1.1 (Unit) Scaffold the renderer with Tailwind, the UI primitives, and a store that folds pushed messages into the loaded task — R2.2
- [x] 1.2 (Unit) Build the settings view: key, model with preset, limits, discard, Docker, images and sign-in — R1.1, R1.2, R1.3
  _Depends 1.1_

## 2 · Tasks

- [x] 2.1 (Unit) Build the new task form and the task list with state, time, cost and retry — R2.1, R3.1
  _Depends 1.1_
- [x] 2.2 (Unit) Build the task view: todos, delegations, live event log, usage per agent and cancel — R2.2, R2.5, R2.6
  _Depends 2.1_
- [x] 2.3 (Unit) Build the delegation detail with context package, report, evidence and files, and the patch review with approve and reject — R2.3, R2.4
  _Depends 2.2_
- [x] 2.4 (Unit) Show changes another app made, pushed by the core's watcher — R3.2


## 3 · Settings in tabs

- [x] 3.1 (Unit) Show the Settings view's sections in tabs, one per section, from a list of the sections in the renderer's lib — R1.4
  _Reason Settings grew a fifth section, the MCP integrations, and one long page became hard to read_
