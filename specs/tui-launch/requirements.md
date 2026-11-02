---
autonomy: auto
ci: wait
branch: feat/tui-revamp
delivery: in-review
pr: 17
---

# TUI launch — requirements

## Purpose

`harness-for-rea` run in a folder opens that folder as a project, the way a coding harness opens the
repository it is run in: the folder it is run in, or the path it is given, is the target of the
project the TUI opens, finds or offers to create, with the first-run setup inline when it has not
been done. A folder that holds far more than one target asks before it is mounted into a sandbox
(adr:0013-give-the-sandboxes-full-internet-access: what is mounted is the isolation).

## R1 · The folder

- **R1.1** The TUI shall take as the target folder the path given as its first argument, or the folder it is run in when none is given.
- **R1.2** When exactly one project has the target folder as its target, the TUI shall open that project.
- **R1.3** When several projects have the target folder as their target, the TUI shall list them to pick from, newest first, with one more choice to create another.
- **R1.4** When no project has the target folder as its target, the TUI shall offer to create one prefilled with the folder's name, the target's detected kind, the goal to understand and map, and the Settings provider, model and efforts.
- **R1.5** If the target folder is a home folder, a drive or file-system root, a Downloads folder or a folder holding the app's data folder, then the TUI shall ask the user to type the folder's path to confirm before creating a project on it.
- **R1.6** If the target folder is the app's data folder or inside it, then the TUI shall refuse to create a project on it and say why.
- **R1.7** If the path given does not exist, then the TUI shall print why and exit without starting the core.

## R2 · Setup and resuming

- **R2.1** While the first-run setup is not completed, the TUI shall open on the setup and continue with the folder once it is completed.
- **R2.2** When the TUI is started with the continue flag, the TUI shall open the folder's project's most recent task.
- **R2.3** When the TUI is started with the resume flag, the TUI shall list the folder's project's tasks to pick one to open.
- **R2.4** The `/projects` command shall list every project, with the app holding it, to open any of them.
- **R2.5** The TUI shall answer `--help` and `--version` without starting the core.

## Out of scope

- A non-interactive mode that prints an answer and exits.
- Opening a single file as the target from the command line; a file target is created from the new-project dialog.
