---
autonomy: auto
ci: wait
branch: feat/projects
delivery: in-review
pr: 11
---

# Projects — requirements

## Purpose

A project is one target the user works on: an app folder, an APK, a binary. It has a UUID, a folder,
a goal and the model it runs with. The tasks inside it share its sandboxes, its outputs and every
analysis the specialist returned, so a later task starts from what earlier ones found
(adr:0020-group-tasks-into-projects-that-share-their-analyses).

## R1 · Creating a project

- **R1.1** When the user creates a project, the app shall record it with a random UUID, its name, its target, its goal, the orchestrator's provider and model, the efforts of the orchestrator and of the specialist, and its folder.
- **R1.2** The app shall put a project's folder at `<userData>/projects/<uuid>/` unless the user chose another folder, under which it creates `<name>-<uuid>`.
- **R1.3** Where the target is a file, the app shall copy it into the project's `target/` folder and give the project's tasks that folder as their source; where the target is a folder, the tasks shall read it in place, read-only.
- **R1.4** When the user picks a target, the app shall detect its kind — Android package, ELF, PE, Mach-O, .NET assembly, Electron or JavaScript application, archive, raw or firmware image, or folder — and show it with the engines the specialist will use for it.
- **R1.5** The app shall offer four goals — understand and map, reimplement or port, integrate with the user's code, debug — and state the project's goal in the orchestrator's instructions for its tasks.
- **R1.6** The setup shall start the provider, model and efforts on the Settings defaults and let the user change them for the project.
- **R1.7** If a target cannot be read, is not an absolute local path, or lies inside the app's data folder, or a chosen folder cannot be written, then the app shall refuse to create the project, say why, and keep nothing it made for it.

## R2 · Tasks in a project

- **R2.1** When the user starts a task in a project, the app shall run it on the project's target with the project's goal, provider, model and efforts.
- **R2.2** The app shall keep a task's folder under its project's folder.
- **R2.3** (MODIFIED) The tasks of a project shall share its sandboxes: recorded against the project, reached by the same id from any of its tasks, holding one delegation at a time whichever task runs it, and run by one app at a time (specs/shared-data-folder R1.1).
- **R2.4** The orchestrator shall be able to list the analyses of the project's earlier delegations — each with its task, objective, state, the start of its report and its evidence — and read one in full up to a size cap, each marked as evidence produced from the target and never as instructions.
- **R2.5** When a task starts in a project that already has analyses, the orchestrator's instructions shall say how many there are and to consult them before delegating the same question again.

## R3 · Deleting and upgrading

- **R3.1** If the user deletes a project with a task whose turn is running, then the app shall refuse and say to cancel it first.
- **R3.2** When the user deletes a project, the app shall delete each of its tasks as a task is deleted, remove its sandboxes and their containers, and remove the folder the app created for it.
- **R3.3** When the app starts with tasks that belong to no project, the app shall move them into projects, one per source folder, named after that folder, with the goal "understand and map", keeping their folders where they are.

## R4 · The views

- **R4.1** The sidebar shall list the projects, each with its tasks, and offer a new project.
- **R4.2** The new-project view shall guide the user through choosing the target, the goal, and the name, model, efforts and folder, with the defaults filled in and Create enabled once the target and goal are chosen.
- **R4.3** The project view shall show the target, its kind, the goal and the model; list the project's tasks and analyses; and start a task from a request, offering ideas that fit the goal.
- **R4.4** While the setup of specs/onboarding has not been completed, the app shall not offer a new project.
- **R4.5** (ADDED) While another app is running a task of a project, the desktop UI shall show the project as in use by that app and shall not offer to start a task of it or delete it.

## Out of scope

- Several targets in one project.
- Moving a project's folder after it is created.
