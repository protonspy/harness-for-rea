# TUI panels — design

## What changes

Serves R1–R4. Every panel calls the API methods the desktop app's matching view calls; the parity
test of plans/tui-revamp 1.6 holds the set.

- `components/Sidebar.tsx` (R1.1) — the plan from the task's `plan` steps, the delegations with
  their state, `usageByAgent` with the specialist's cost marked `~`, and the files from
  `filesOfStep` over the delegations.
- `screens/EventLog.tsx` (R1.2) — the loaded events, newest last; Tab cycles the agent filter
  (all, orchestrator, specialist, app), Enter opens an event's payload in a dialog.
- `screens/Project.tsx` (R2.1, R2.2) — the project overview: target, kind, goal, model, the app
  holding it, tasks, analyses, unknowns; the prompt starts a task; `/delete-project` asks for the
  name typed.
- `screens/NewProject.tsx` (R2.3) — a form of fields moved through with Tab: the target path,
  checked with `detectTarget` as it is typed, the goal, the name prefilled from the path, the
  model and the efforts from `getSettings`.
- `screens/Setup.tsx` (R3) — the three steps from `readiness`, `sandboxStatus` and `loginStatus`,
  refreshed on `sandbox` and `login` pushes; the build log in a scrollbox (R3.2); `/login` starts
  the sign-in and `openLoginUrl` opens the browser, `/code`, `/cancel-login`, `/logout` (R3.3);
  `/provider`, `/base-url`, `/key`, `/remove-key`, `/model` with a picker from `listModels`
  (R3.4); `/done` calls `completeSetup`.
- The shell checks `readiness` after `sandbox` and `login` pushes once the setup is completed and
  shows a banner naming the step that stopped being ready, with `/setup` (R3.5).
- `screens/Settings.tsx` (R4) — a form over `saveSettings` for the provider, model, efforts and the
  three timeouts, and `/setup`.
