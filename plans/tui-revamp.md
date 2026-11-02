---
autonomy: auto
ci: wait
status: approved
pr: per-plan
merge: manual
checksum: 495c3f89e37d5d0beec8021cf771d7c88fa8e9588aad1d2624c2087719a6cd15
---

# TUI revamp

A terminal UI for Harness for REA that works like the harness TUIs engineers already use — Claude Code
and OpenCode — and does everything the desktop app does: it opens on the folder it is run in, sets
itself up there, and shows each task as a live, readable conversation. Rebuilt on OpenTUI's React
layer over the core both apps share, with the data folder shared between any number of processes.

## Why

The 0.1 TUI is a thin imperative prototype: it ignores the folder it is started in, its one input line
and plain-text body make tasks hard to follow, several screens behave unexpectedly, and it lacks most of
what the desktop app offers (setup flow, settings, delegations, usage, event log, patches, decisions).
Its data-folder lock also lets only one app run at a time. Done means `harness-for-rea` run in any
folder opens that folder as a project, several terminals and the desktop app run side by side on one
data folder, and a task in the TUI can be started, followed, steered and reviewed with the same
information and actions the desktop app offers, through the interactions of Claude Code and OpenCode:
a status line, a multi-line prompt with history, slash commands and a command palette, file mentions,
collapsible tool calls, markdown and syntax-highlighted code, diffs, and dialogs for questions.

## Paths

- `tui/` — the TUI, rebuilt on `@opentui/react`; its npm package, `tui/src/paths.ts` flags and binary build
- `src/main/core.ts`, `src/main/lock.ts`, `src/main/db.ts`, `src/main/events/log.ts`, `src/main/projects.ts`, `src/main/status.ts`, `src/main/credentials.ts`, `src/main/sandbox/taskbox.ts`, `src/main/sandbox/specialistbox.ts` — sharing the data folder between processes
- `src/renderer/src/lib/` — the pure view logic both UIs reuse (timeline, chat, store, virtual window, format)
- `src/renderer/src/` views — the desktop side of the per-project lock and of cross-process refresh
- `src/shared/api.ts`, `src/shared/types.ts` — the refusal of a busy project, and anything the TUI needs that the API does not expose
- `scripts/test-gate.mjs`, `.github/workflows/ci.yml`, `scripts/build-cli.ts`, `README.md`, `docs/adr/`, `docs/stack.md`
- `tests/lock.test.ts`, `tests/bun-core.test.ts` — assert the folder-wide lock and are rewritten with it

## References

- `specs/shared-data-folder/` — several processes on one data folder, under task 1.3's ADR: a lock per project held while a task of it starts or runs (the desktop app browses freely and shows a busy project as taken by the other app); tasks owned by a process identified by pid and start time, so start-up recovery and both container sweeps touch only tasks and containers of a process that is gone; SQLite with a busy timeout, migrations run once under a lock, and a database newer than the app refused naming the newer app; the first-start upgrade, the image build and the Claude sign-in done once across processes; the Electron single-instance lock kept; provider keys in one OS-keychain store both apps read; each app noticing changes another process made and refreshing within a stated latency
- `specs/tui-shell/` — the TUI's shell on `@opentui/react`: a layout of status line, transcript, prompt and a toggled sidebar; theme tokens matching the desktop app's dark and light themes; one keybinding system with a help overlay (`?`); slash commands with autocompletion and a command palette (Ctrl+P) over the same commands; dialogs, overlays and toasts; Esc to interrupt and Ctrl+C twice to quit; screen tests on OpenTUI's test renderer with simulated keys
- `specs/tui-launch/` — the folder it is run in as the project's target: `harness-for-rea [path]` opens the project whose target is that folder, lists them to pick from when there are several, or offers to create one prefilled (name from the folder, detected kind, goal, the Settings model); a home folder, a drive root, Downloads or a folder holding the app's data asks for the path to be typed to confirm before it is mounted, and the data folder itself is refused; the first-run setup runs inline when not completed; `--continue` reopens the folder's last task and `--resume` lists its tasks; `/projects` reaches every project
- `specs/tui-conversation/` — a task as a conversation at parity with the desktop timeline: agent messages as markdown with highlighted code, tool calls one line each and expandable, delegations with their context package, report, evidence, files copied, read and written, and the specialist's run, patches as diffs with their approve and reject decision, gated tool calls approved, edited or rejected, questions and the safeguard-refusal choice as selection dialogs, a working indicator with elapsed time, tokens and cost, stop, continue, close, cancel, start over and delete, older pages on scroll-up; a multi-line prompt with history, `@` file mentions completed from the project's target, and messages queued while a turn runs
- `specs/tui-panels/` — the desktop app's panels in the terminal: a sidebar with the plan, delegations, usage per agent and files touched; the event log with its agent filter; the project overview with tasks, analyses, unknowns and deletion; the setup screens with the image build log, the Claude sign-in opening the browser, cancel and sign out, the provider with its base URL, key and a model picker, and the banner when a ready step stops being ready; a settings editor with efforts and timeouts that reopens the setup; the new-project dialog with target detection
- Delivered in order: specs/shared-data-folder, specs/tui-shell, specs/tui-launch, specs/tui-conversation, specs/tui-panels
- adr:0022-run-the-tui-on-bun-with-opentui
- adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted
- adr:0020-group-tasks-into-projects-that-share-their-analyses
- adr:0006-run-the-specialist-inside-a-container-per-task
- [OpenCode's TUI](https://github.com/anomalyco/opencode/tree/dev/packages/tui) on `@opentui/solid`, and Claude Code's on Ink — interaction references, never code to copy

## Out of scope

- Replacing or reducing the desktop app: both stay, on the same data
- A non-interactive mode (`-p "<request>"` printing the answer and exiting)
- Linux builds of the TUI, and mouse-first interaction beyond what OpenTUI gives
- Copying another harness's code, wording, themes or branding

## Tasks

- [x] 1.1 (Unit) Walk the 0.1 TUI through setup, a project, a long task, a question and a refusal against the desktop app, and write each defect with the steps that show it, and each parity gap — every API method the renderer's views call that the TUI does not reach — to `docs/wiki/pages/tui-0-1-defects.md`, each later linked from the spec that fixes it
  _Priority 1_
- [x] 1.2 (Unit) Record as an ADR amending adr:0022-run-the-tui-on-bun-with-opentui the TUI's move to OpenTUI's React layer — why React over Solid and over the imperative API, and what of `src/renderer/src/lib` it shares — with `docs/stack.md` entries for `@opentui/react`, `react-reconciler` and the peers `legacy-peer-deps` will not install
  _Priority 1_
- [x] 1.3 (Unit) Record as an ADR sharing the data folder between processes, amending adr:0017 and the folder-wide lock of plans/finish-the-harness 1.9: the per-project lock and when each app takes it, process-owned tasks identified by pid and start time, recovery and both container sweeps scoped to processes that are gone and run at the next start of any app, the SQLite busy timeout, migrations under a lock and the refusal of a newer schema, the first-start upgrade, image build and sign-in done once, the Electron single-instance lock kept, how an app learns another process changed a task and how fast, and the shared keychain store with `@napi-rs/keyring` and its `docs/stack.md` entry
  _Priority 1_
- [x] 1.4 (Unit) Record as deltas, in the branch that delivers the shared-data-folder spec, the requirements it changes: the tui spec (Purpose, R1.1, R1.2, R1.3 and the out-of-scope line on patches), event-log R3.1, task-persistence R2.3 and R3.4, specialist-sandbox R2.7, projects R2.3 and R4, desktop-ui, and onboarding for the shared key store
  _Depends 1.3_
  _Priority 1_
- [ ] 1.5 (Unit) Run the Bun core tests and the TUI screen tests in CI with Bun 1.4.4 set up as `release.yml` does, folding their results into the total of `scripts/test-gate.mjs` and the recorded command in `.claude/rules/project.md`, with one smoke screen test so the job fails when OpenTUI's test renderer does not start
  _Depends 1.2_
- [ ] 1.6 (Unit) Test that every API method the renderer's views and components call is reachable from a TUI command, screen or dialog, so parity is checked by running rather than by reading
  _Depends 1.1_
- [ ] 1.7 (Unit) Rewrite the README's terminal UI sections for the new TUI: starting in a folder, the keys, the commands and running beside the desktop app
  _Depends 1.6_
  _Priority 3_
- [ ] 1.8 (Unit) Render the chat's agent and user messages as markdown with
      react-markdown in the desktop app, and color the code blocks in them with
      CodeMirror's Lezer parsers through one highlighter in src/renderer/src/lib that
      the TUI's transcript draws too, recorded as a delta to specs/chat R7 with
      docs/stack.md entries
  _Reason Asked by the user during the run: markdown in the desktop chat and syntax colors from Lezer_

## Done when

- `scc validate --checks --pr` exits 0 with every referenced spec's tasks ticked and every task above ticked or struck out with a reason
- `harness-for-rea` run in a folder with no project opens the creation dialog prefilled for it, run again opens that project directly, and `--continue` reopens its last task
- Run in a home folder it asks for the path to be typed before mounting it, and in the app's data folder it refuses
- Two TUIs in two folders and the desktop app run at the same time; starting a task in a project another app is running a task in is refused naming that app; killing one app leaves the others' running tasks untouched, and its own are recovered at the next start
- Two apps started together on a fresh data folder produce one project per source folder and one image build, and an app opening a database with a newer schema is refused naming the newer app, each checked by a test
- A provider key saved in either app is used by the other without being entered again
- Every API method the renderer calls is reachable in the TUI, checked by task 1.6's test
- In the TUI, a task with a delegation shows markdown, a collapsed tool call that expands, the delegation's report and the specialist's run inside it, a question answered from a dialog, the working indicator, and its usage and plan in the sidebar, checked by screen tests and in a real terminal recorded in the PR body
- Every slash command is listed by `/` with autocompletion and by the command palette, and `?` lists every key, each checked by a screen test
- The TUI's screen tests and the Bun core tests run in CI and count in the gate's total
