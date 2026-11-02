# TUI launch — design

## What changes

Serves R1, R2.

- `tui/src/paths.ts` — `parseArgs(argv)`: the target path, `--continue`, `--resume`, `--theme`,
  `--help`, `--version`; an unknown flag is an error printed with the usage (R2.5).
- `tui/src/lib/launch.ts` (new, pure) — `riskOf(folder, env)` names why a folder is too broad to
  mount — a home folder, a drive or file-system root, a Downloads folder, a folder holding the data
  folder — or that it is the data folder, refused (R1.5, R1.6); `matchProjects(projects, folder)`
  compares targets case-insensitively on Windows, with separators and a trailing separator
  normalised (R1.2, R1.3); `launchPlan(...)` turns the matches and the flags into what the TUI opens
  first.
- `tui/src/main.tsx` — a path that does not exist is printed and the process exits before the core
  starts (R1.7).
- `tui/src/screens/Launch.tsx` — runs the plan once the setup is completed (R2.1): opens the
  project, or a picker over the matches with a "create another" entry, or the new-project dialog
  prefilled from `detectTarget` and `getSettings`; `--continue` opens the newest task, `--resume`
  a picker of the tasks (R2.2, R2.3).
- `/projects` opens a picker over `listProjects`, each marked with the app holding it (R2.4).

## Why typing the path

A home folder or a drive is not refused: an analyst may mean it. Typing it, rather than pressing
Enter on "yes", is the confirmation that cannot happen by accident, as deleting a repository on a
forge asks for its name.
