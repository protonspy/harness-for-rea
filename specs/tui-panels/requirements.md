---
autonomy: auto
ci: wait
branch: feat/tui-revamp
delivery: merged
pr: 17
---

# TUI panels — requirements

## Purpose

The desktop app's panels in the terminal, so nothing the desktop app offers needs the desktop app:
the task's sidebar, its event log, a project's overview, the first-run setup with each of its steps,
the settings, and the new-project dialog. Each reaches the same API methods the desktop app's views
call (plans/tui-revamp 1.6). Fixes the setup and settings defects and the parity gaps of
[[tui-0-1-defects]].

## R1 · The task's sidebar and event log

- **R1.1** The sidebar shall show the open task's plan, its delegations with their state, its usage per agent with the specialist's cost marked as an estimate, and the files it touched.
- **R1.2** The TUI shall show a task's event log, newest last, filtered by agent, with each event's details on request.

## R2 · Projects

- **R2.1** The project overview shall show the project's target, kind, goal and model, its tasks, its analyses and its unknowns, and start a task from a request.
- **R2.2** The project overview shall let the user delete the project after typing its name to confirm.
- **R2.3** The new-project dialog shall take a typed target path, show the target's detected kind, and take the goal, name, model and efforts with the Settings defaults filled in.
- **R2.4** (ADDED) The TUI shall let the user change a project's model and efforts from its overview and a task's model from the task, `/model` picking from the provider's list or taking a name (specs/projects R1.8, R2.6).

## R3 · Setup

- **R3.1** The setup shall show its three steps with their state — the sandbox images, the Claude sign-in and the orchestrator's provider — and let the user complete it once every step is ready.
- **R3.2** The sandbox step shall show the image preparation's log as it runs and let the user prepare the images again.
- **R3.3** The sign-in step shall open the sign-in page in the browser, take the code pasted back, and let the user cancel the sign-in or sign out.
- **R3.4** The provider step shall let the user pick the provider, set its base URL where it takes one, set or remove its key, and pick the model from the provider's list or by name.
- **R3.5** While a setup step that was ready no longer is, the TUI shall show a banner naming the step, with a command that opens it.

## R4 · Settings

- **R4.1** The settings editor shall let the user change the provider, the model, the orchestrator's and the specialist's effort, the delegation timeout and the approval and question timeouts.
- **R4.2** The settings editor shall open the setup again.
