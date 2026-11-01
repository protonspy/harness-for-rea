---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: in-progress
---

# TUI — requirements

## Purpose

A terminal UI for Harness for REA beside the desktop app, for a user who works in a terminal or on a
machine without a desktop: the same core, the same data folder and the same projects and tasks, on
OpenTUI under Bun (adr:0022-run-the-tui-on-bun-with-opentui). Only one of the two apps holds the data
folder at a time.

## R1 · Start

- **R1.1** The TUI shall run the core the desktop app runs, on the data folder the desktop app uses, behind the same handlers.
- **R1.2** If the desktop app holds the data folder, then the TUI shall print which app holds it and exit without opening the database.
- **R1.3** The TUI shall keep each provider's key in the OS keychain, asked for once and read from there at every start.

## R2 · Setup

- **R2.1** While the first-run setup is not completed, the TUI shall show its three steps — the sandbox images, the Claude sign-in and the orchestrator's provider, key and model — each with its state and the action that readies it.
- **R2.2** When every step is ready, the TUI shall let the user complete the setup and then open the projects.

## R3 · Projects and tasks

- **R3.1** The TUI shall list the projects and let the user create one from a name, a goal, a target path and a model.
- **R3.2** When the user opens a project, the TUI shall list its tasks and let the user start a task from a request.
- **R3.3** When the user opens a task, the TUI shall show its chat timeline — messages, tool calls and delegations, newest page first with older pages on request — and update it as events arrive.
- **R3.4** While a task waits on a question, including the choice after a safeguard refusal, the TUI shall show the question with its kind and let the user answer it.
- **R3.5** The TUI shall let the user send a message to a task, stop its turn, and cancel it.

## Out of scope

- Reviewing a patch's diff in the terminal: patches are applied without asking in every task (specs/chat R4.1).
- Mouse interaction beyond what OpenTUI gives by default.
