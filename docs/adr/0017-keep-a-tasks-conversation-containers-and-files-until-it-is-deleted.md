---
status: accepted
---

# 0017 · Keep a task's conversation, containers and files until it is deleted

## Context

A task's conversation lives in LangGraph's `MemorySaver`, so it is gone when the app quits;
`recover()` then closes every conversation and a task can only be retried from its request.
Cancelling or closing a task removes its task container (adr:0015-run-the-task-container-as-root)
and its sandboxes (adr:0016-let-the-orchestrator-run-the-specialists-sandbox), and with them
`/scratch`, every tool installed and everything the specialist extracted; discard on completion
deletes each delegation's workspace as it ends. The user ruled that nothing may be lost when a
container goes: a cancelled task, reopened, continues from where it stopped, with its history and
the files already analysed. The stack keeps no native module (`node:sqlite`,
adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task), and LangGraph's SQLite saver is built
on `better-sqlite3`.

## Decision

A task keeps its conversation, containers and files until the user deletes it. The checkpointer
is `MemorySaver` with every checkpoint and write also stored in the app's SQLite database and a
thread loaded back from it when the task reopens, so LangGraph's own logic keeps deciding what a
checkpoint holds. Every file of a task lives under `<userData>/tasks/<taskId>/`: the
orchestrator's `/scratch`, now a writable bind of `tasks/<id>/scratch` rather than a folder in
the container, each delegation's workspace, run directory and snapshot, and each sandbox's
`/work` and the specialist's own `/root/out`, also bound from there. Containers lose `--rm`:
cancelling, closing or quitting stops them, reopening starts them, and one Docker no longer has
is created again over the same folders, with the orchestrator told that installed tools were
reset. Sandboxes are recorded in the database so a reopened task reaches them by the same id.
Cancelled, failed, interrupted and closed tasks reopen on the user's message or on Continue.
Deleting the task — refused while it runs — removes its containers, folder, patches,
conversation and records; nothing else does, and the discard setting goes. Rejected:
LangGraph's SQLite saver, a native module the stack avoids; `docker commit` of each container on
stop, which keeps installed tools but costs gigabytes per task; keeping files only in the
containers, which a `docker system prune` or a Docker reset erases.

## Consequences

- Disk grows with every task until the user deletes it; the app does not clean up by itself.
- Two more host folders are mounted per container: `/scratch` in the task container and
  `/root/out` in a sandbox, each the task's own folder; nothing outside `tasks/<id>/` is mounted.
- Stopped containers stay in Docker and appear in `docker ps -a`; starting the app no longer
  removes them.
- What a tool installed survives a stop but not a container Docker removed; the files do.
- A delegation cut off mid-run is not resumed inside Claude Code: the orchestrator delegates
  again, over the files that remain.
- What containers write — samples, extracted payloads, links, special files — stays on the host
  under `%AppData%` until the task is deleted; the app never opens or runs anything there, and
  deleting removes each entry with `unlink`, never following a link.
- A container is reused only while it carries the fingerprint of the arguments the app would
  create it with now; one made by an older app, with another image or boundary, is created
  again over the same folders.
