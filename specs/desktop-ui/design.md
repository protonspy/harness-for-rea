# Desktop UI — design

## What changes

Serves R1.1, R1.2, R1.3, R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R3.1.

`src/renderer/` is a React app on Tailwind CSS with a handful of Radix-based
primitives in the shadcn/ui style, as in `study-lab`. It talks to main only through
`window.hfr` (`specs/app-shell/`). Three views: **Tasks** (new task form, task
list and history), **Task** (todos, delegations, live log, evidence and files,
patch review, usage, cancel and retry) and **Settings**.

State is a small store in `src/renderer/src/lib/`: the selected task's history is
loaded once from `getTask`, and every pushed `event`, `step` and `task` message is
folded into it by a pure reducer, so live updates and history render through the
same code. The reducer and the formatting helpers are what the suite tests; the
views are checked by running the app.
