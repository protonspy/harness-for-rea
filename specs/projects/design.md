# Projects — design

## What changes

Serves R1.1–R4.4, under adr:0020-group-tasks-into-projects-that-share-their-analyses.

- `src/main/db.ts` — migration 3: a `projects` table, and `project_id` on `tasks` and on `sandboxes`.
- `src/main/projects.ts` (new) — the project store and lifecycle: create (folder, target copy),
  list, get, delete; the upgrade of tasks with no project (R3.3).
- `src/main/target.ts` (new) — the target's kind, from its extension and first bytes, with the
  engines for each kind (R1.4).
- `src/main/events/log.ts` — `taskDir` resolves under the task's project folder (R2.2).
- `src/main/sandbox/specialistbox.ts` — `SpecialistBoxes` is per project. A registry in the main
  process keeps one instance per project while any of its tasks is open, so the busy flag holds
  across tasks (R2.3).
- `src/main/orchestrator/runner.ts`, `agent.ts`, `tools.ts` — a task runs with its project's model,
  efforts and goal. Two read-only tools, `project_analyses` and `read_analysis`, read the project's
  delegation steps (R2.4). The instructions state the goal and the count of earlier analyses (R1.5,
  R2.5).
- `src/shared/api.ts`, `src/main/index.ts` — `createProject`, `listProjects`, `getProject`,
  `deleteProject`, `pickTarget` (file or folder), `detectTarget`; `startTask` takes a project id.
- `src/renderer/src/` — a sidebar of projects and their tasks; `NewProject.tsx`, a guided setup of
  three steps with selectable cards; `ProjectView.tsx`; shadcn/ui components it needs (select,
  stepper cards, dialog) with Lucide icons. Artwork comes from pixellab-cli
  (plans/projects-and-onboarding.md).

## Data

```
projects(id, name, goal, target_path, target_kind, source_root, folder, owns_folder,
         provider, model, orchestrator_effort, specialist_effort, created_at, updated_at)
tasks.project_id      → projects(id), ON DELETE CASCADE
sandboxes.project_id  → projects(id), ON DELETE CASCADE
```

`source_root` is what tasks mount read-only: the target folder, or `<folder>/target/` for a file
target. `owns_folder` says whether the app created `folder` and may remove it whole.

An upgraded task's project has `folder = <userData>` and `owns_folder = 0`, so the task's folder,
`<userData>/tasks/<id>`, stays where it is. A new project's tasks live in `<folder>/tasks/<id>`.
