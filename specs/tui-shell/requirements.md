---
autonomy: auto
ci: wait
branch: feat/tui-revamp
delivery: in-progress
---

# TUI shell — requirements

## Purpose

The frame every screen of the terminal UI lives in, rebuilt on OpenTUI's React layer
(adr:0023-build-the-tui-on-opentuis-react-layer): a status line, the screen's body, a prompt and a
sidebar to toggle, one theme drawn from the desktop app's colors, one keyboard map, slash commands
and a command palette over the same commands, and dialogs, overlays and toasts — the interactions
engineers know from harness TUIs, with nothing copied from them. Fixes the shell defects of
[[tui-0-1-defects]].

## R1 · Layout and theme

- **R1.1** The TUI shall lay out every screen as a status line, the screen's body, a prompt and a sidebar the user can toggle.
- **R1.2** The status line shall show the project and task open, the task's state, and the key that opens the help.
- **R1.3** The TUI shall draw with theme tokens taken from the desktop app's dark colors, and a light variant chosen by `--theme light` or the `HFR_THEME` variable.
- **R1.4** When the terminal is resized, the TUI shall lay the screen out again at the new size.
- **R1.5** While a list on a screen is updated by a push, the TUI shall keep the item the user selected.

## R2 · Keys and commands

- **R2.1** The TUI shall read every key through one key map, and `?` shall open an overlay listing every key with what it does on the current screen.
- **R2.2** When the user types `/` at the start of the prompt, the TUI shall list the slash commands available on the current screen, narrowed as the user types and completed with Tab.
- **R2.3** When the user presses Ctrl+P, the TUI shall open a command palette listing the same commands as `/`, searchable, that runs the one chosen.
- **R2.4** When the user presses Esc while a turn runs, the TUI shall stop the turn; otherwise Esc shall close the open dialog or overlay, or go back one screen.
- **R2.5** When the user presses Ctrl+C, the TUI shall clear the prompt or, with the prompt empty, ask for a second Ctrl+C within two seconds before it quits.

## R3 · Dialogs and messages

- **R3.1** The TUI shall show a choice, a confirmation or a typed value it needs as a dialog over the screen, answered with the keyboard.
- **R3.2** When an action succeeds or fails, the TUI shall say so in a toast that stays until it times out, an error staying longer than a success.
- **R3.3** If text from a target, an agent or a tool holds terminal control characters, then the TUI shall remove them before drawing it.

## R4 · Screen tests

- **R4.1** The TUI's screens shall be testable on OpenTUI's test renderer with simulated keys against a scripted API, with no core and no Docker.

## Out of scope

- Mouse-first interaction beyond what OpenTUI gives.
- A theme of the TUI's own that differs from the desktop app's colors.
