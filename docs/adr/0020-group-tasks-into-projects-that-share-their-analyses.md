---
status: accepted
---

# 0020 · Group tasks into projects that share their analyses

## Context

A task names a source folder and stands alone. Its conversation, containers, sandboxes and files are
its own (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted), so a second
task on the same APK starts from nothing: it re-extracts, re-installs and re-delegates what the first
one already established.

The user asked for projects in the spirit of rebuild tools such as craft-anything (see the wiki).
A project is one target set up through guided choices, with its own UUID and workspace, and every
analysis is kept. The choices are the goal, the target with its detected kind, and the model and
effort. The user also asked that the tasks of a project share its sandboxes, outputs and analyses,
and that the project's folder default to the app's data folder with the option of another.

## Decision

A project owns one target and any number of tasks.

**Its own:**

- a UUID;
- a folder, `<userData>/projects/<uuid>/` or under a folder the user chose;
- a goal;
- the provider, model and efforts its tasks run with.

**The target.** A file target is copied into the project's `target/` folder, and that folder is what
tasks mount read-only. A folder target is mounted in place, read-only, as before. Copying keeps a
file's siblings, a Downloads folder say, out of every container.

**Shared by its tasks:**

- *Sandboxes.* The project's sandboxes, which become project-scoped records, so any of its tasks
  reaches one by id. One object per project in the main process holds the one-delegation-at-a-time
  rule across tasks.
- *Outputs.* Each task's folder lives under the project's folder.
- *Analyses.* The orchestrator reads the project's earlier delegation steps — objective, report,
  evidence — through two read-only tools, and is told how many exist when a task starts.

**Upgrade.** Tasks from before projects are moved into one project per source folder, with the app's
data folder as the project's folder, so their files stay where they are.

**Rejected:**

- Copying earlier reports into every new task's prompt, which grows each prompt with analyses the
  task may not need.
- Sharing the orchestrator's conversation between tasks, which would merge unrelated threads.
- Mounting a file target's parent folder, which exposes its siblings.

## Consequences

- Two tasks of a project can run at once, and they queue on a shared sandbox rather than run in it
  together.
- Deleting a project deletes its tasks. A folder the user chose is kept, and only what the app
  created inside it goes.
- A target file is stored twice on disk: the user's original and the project's copy.
- What one task's specialist writes to a shared sandbox's `/work` is visible to the next task's
  delegations there. That is the point, and also how a mistake carries over.
- An analysis is stored and replayed to every later task of the project, so text a hostile target
  planted in a report outlives its task. The orchestrator reads analyses as evidence marked as
  coming from the target, never as instructions, and reads each up to a size cap.
