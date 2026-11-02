---
status: accepted
---

# 0025 · Remove the containers on a forced stop

## Context

adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted made cancelling, closing
and quitting stop a task's containers and keep them, so what a tool installed survives until the
task reopens. In use, a forced stop — a cancelled task, an app quit with tasks open, or an app
killed and swept at the next start — leaves stopped containers piling up in `docker ps -a`, one per
task and per sandbox, though nothing of the task's lives only in them: adr:0017 already put every
file a task writes under `tasks/<id>/` on the host, bound into the containers, and the conversation
in SQLite. The user asked for the instances to go on a forced stop, with the task kept.

## Decision

A forced stop removes the containers; an ordinary end keeps them stopped.

- **Forced**: cancelling a task, quitting the app with a task open, and the start-up sweep of the
  containers a gone process left running (adr:0024-share-the-data-folder-between-processes). The
  task container is removed (`docker rm -f`); the project's sandboxes are removed once no task of
  the project is open, their records kept.
- **Ordinary**: closing a conversation, and the end of a turn. The containers are stopped and kept,
  as adr:0017 has it, so installed tools survive the common case of coming back to a task.

Nothing of the task is lost either way: `/scratch`, each sandbox's `/work` and `/root/out`, the
delegations' workspaces and the conversation's checkpoints stay, and a reopened task creates the
containers again over the same folders and tells the orchestrator that what was installed is gone —
the path adr:0017 already takes when Docker has lost a container.

Rejected: removing on every end, which loses installed tools on each close; keeping on every end,
which is what piled up.

## Consequences

- After a cancel, a quit or a crash, a reopened task starts on fresh containers and reinstalls
  what it needs; its files are where they were.
- `docker ps -a` holds stopped containers only for tasks closed in the ordinary way.
- adr:0017 holds for files, conversation and the ordinary end; this record amends only what a
  forced stop does to the containers.
