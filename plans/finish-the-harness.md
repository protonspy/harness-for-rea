---
autonomy: auto
ci: wait
status: approved
pr: per-plan
merge: manual
checksum: 76ccfa9414d64af7e02c3ca38c83a74a9894b3ee2e4f268999b3acad95feac67
---

# Finish the harness

Everything still pending for Harness for REA after projects and onboarding: a chat timeline that
holds long runs, a specialist whose questions and refusals never stall a task, the terminal UI and
its release to GitHub and npm, the README, and the Craft Anything ideas that make an analysis
checkable.

## Why

Long tasks freeze the task view, every specialist question waits on the user even when the
orchestrator could answer it, a safeguard refusal looks like any other failure, and the app only
runs from source on one desktop. The work is done when a long task's history scrolls within a
frame budget, questions are answered by the orchestrator first and refusals wait on the user's
choice, the desktop app and the CLI/TUI ship from a manual release on `main` for Windows x64 and
macOS arm64/x64 with the CLI on npm, and an analysis carries a contract, an unknowns ledger and
replayable test vectors.

## Paths

- `src/renderer/src/views/TaskView.tsx`, `src/renderer/src/lib/chat.ts`, `src/renderer/src/lib/store.ts`, `src/renderer/src/components/chat/`
- `src/main/events/log.ts`, `src/main/index.ts`, `src/main/credentials.ts`, `src/shared/api.ts`, `src/shared/types.ts`
- `src/main/delegation.ts`, `src/main/orchestrator/`, `src/main/sandbox/docker.ts`, `sandbox/specialist/`
- `tui/`, `.github/workflows/release.yml`, `electron-builder.yml`, `package.json`, `docs/stack.md`, `docs/adr/`, `README.md`

## References

- `specs/chat-timeline/` — the task view as a chat timeline in the style of Claude Code Web and Codex Web: each agent's turns, tool calls and delegations, the specialist's tool calls nested under its delegation; newest events first through a `before` cursor with older pages on demand, scroll anchored when a page is prepended, only what is near the viewport rendered, events folded incrementally, usage and step state read from the main process rather than from the loaded page, payloads collapsed until opened; deltas to `specs/desktop-ui/` R2.2 and `specs/event-log/` for paged reads in both directions
- `specs/specialist-lifecycle/` — owned by this plan, and the spec plans/specialist-rea.md also names: a specialist question answered by one call to the orchestrator's model with the delegation's context, and put to the user only when it needs a fact only the user has; a safeguard refusal as its own state with its own event kind, distinct from the app's `sandbox.refused`, told to the orchestrator, where the user stops the task, skips the step, or asks for a different technical approach, never a reworded request nor a purpose added to the brief; the specialist container's removal and the Opus pin verified
- `specs/analysis-contract/` — the specialist's report as a JSON contract the orchestrator validates, a report that fails it returned to the specialist, and an unknowns ledger per project whose open items reach the next task's context package
- `specs/vector-replay/` — test vectors an analysis records, replayed in the sandbox against a reimplementation to check it behaves as the target does
- `specs/tui/` — a terminal UI on OpenTUI beside the Electron app, on the core shared with it behind interfaces for its Electron-only parts, the provider key entered once and kept in the OS keychain, the first-run setup and projects adapted to the terminal, and refusing to start while the desktop app holds the data folder, as the desktop app refuses while the TUI does
- `specs/release/` — a manually dispatched workflow on `main` that builds the desktop app and the CLI/TUI for Windows x64, macOS arm64 and macOS x64, unsigned with the macOS first-run workaround documented, publishes them to GitHub Releases, and publishes the CLI to npmjs with its token as a repository secret
- Delivered in order: specs/chat-timeline, specs/specialist-lifecycle, specs/analysis-contract, specs/vector-replay, specs/tui, specs/release
- adr:0006-run-the-specialist-inside-a-container-per-task
- adr:0008-ask-the-user-from-the-specialist-over-the-run-channel
- adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code
- adr:0018-make-rea-native-to-the-specialist
- adr:0019-keep-the-specialists-brief-technical
- adr:0020-group-tasks-into-projects-that-share-their-analyses

## Out of scope

- Rewording a refused request, or adding a purpose or authorization to the brief, so the specialist accepts it
- Signing or notarizing the release binaries, and auto-update
- Linux builds, and a web build of the desktop UI
- Replacing Electron with the TUI: both are kept, never running at once on one data folder

## Tasks

- [x] 1.1 (Unit) Write `README.md`: what the harness is, how the orchestrator and the sandboxed specialist split the work, requirements (Docker, a Claude plan, an OpenAI-compatible key), install and first-run setup, projects and tasks, development commands from `.claude/rules/project.md`, and links to the ADRs
- [x] 1.2 (TDD) Prove with a Docker test (`HFR_DOCKER=1`) that a `CLAUDE.md` or settings planted in `/work` by an earlier delegation in a shared sandbox are not loaded by the specialist's Claude Code — settings and hooks are already kept out by `--setting-sources ""` (adr:0018-make-rea-native-to-the-specialist) — asserting "not loaded" and watching it fail first
- [ ] 1.3 (Unit) If 1.2 shows anything still loads, record an ADR amending
      adr:0018-make-rea-native-to-the-specialist, stop it in `claudeArgs` or
      `containerEnv` with the matching `tests/sandbox.test.ts` cases, and keep 1.2 as
      the regression check; if nothing loads, strike this task with 1.2's result as its
      reason
  _Depends 1.2_
  _Status removed_
  _Reason 1.2 showed nothing planted in /work loads: --setting-sources "" and --restricted each keep CLAUDE.md out, and with both removed the Docker test fails_
- [x] 1.4 (Unit) Remind the orchestrator, when a turn has read target files itself more than a fixed number of times without delegating, that deep analysis belongs to the specialist — the fallback adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code names — with the number a tested constant
- [x] 1.5 (Unit) Update `README.md` with the TUI, the npm install and the release downloads with the macOS first-run workaround, after the release spec is delivered
  _Depends 1.1_
  _Priority 3_
- [x] 1.6 (Unit) Record as an ADR the specialist question and refusal behaviour — the orchestrator's model answers first, a refusal waits on the user's choice of stop, skip or a different technical approach — superseding the user-first part of adr:0008-ask-the-user-from-the-specialist-over-the-run-channel and the re-delegation sentence of plans/specialist-rea.md, and add the matching deltas to R5.2, R5.4 and R5.5 of the chat spec
  _Priority 1_
- [x] 1.7 (TDD) Spike: run the core under Bun — `node:sqlite`, DeepAgents and LangGraph, the event log and a scripted delegation — with the Electron-only parts behind interfaces; record the TUI runtime as an ADR with its `docs/stack.md` entries, Bun with OpenTUI if it holds, or Node with a terminal renderer that runs there if it does not
  _Priority 2_
- [x] 1.8 (Unit) Split `src/main/index.ts` into a wiring module the TUI shares and an Electron shell, behind an interface for the key store and the transport, keeping the desktop app's behaviour unchanged
  _Depends 1.7_
- [x] 1.9 (Unit) Guard the data folder with a lock both apps take at start, so the second one says which app holds it and exits, and `log.recover()` never interrupts a live task
  _Depends 1.8_

## Done when

- `scc validate --checks --pr` exits 0 with every referenced spec's tasks ticked and every task above ticked or struck out with a reason
- A task with over 10,000 events opens in under a second, shows correct usage and step state, and scrolls within a frame budget measured in the running app
- A delegation whose specialist asks a question the orchestrator can answer finishes without the user being asked; a safeguard refusal shows its own state and waits for the user's choice
- An analysis report that fails the contract is returned to the specialist; an item left open in one task of a project appears in the next task's context package; a recorded test vector replays against a reimplementation in the sandbox
- A `CLAUDE.md` planted in a shared sandbox's `/work` is not loaded by the next delegation's specialist
- A turn that reads target files past the threshold without delegating gets the reminder
- The TUI refuses to start while the desktop app runs, and the desktop app while the TUI runs, each naming the other
- A manual run of the release workflow on `main` publishes the desktop app and the CLI/TUI for Windows x64, macOS arm64 and macOS x64 to GitHub Releases, each one starts, and `npm install -g` of the published CLI package runs it
- `README.md` exists at the root and its commands run as written, the TUI, npm install and release downloads included
