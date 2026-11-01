---
autonomy: auto
ci: wait
branch: feat/task-persistence
delivery: in-progress
---

# Task persistence — requirements

## Purpose

Nothing of a task is lost when its containers go or the app quits: a cancelled, failed,
interrupted or closed task reopens and continues from where it stopped, with its conversation
and every file it analysed, until the user deletes it
(adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted).

## R1 · Conversation

- **R1.1** The task runner shall store every checkpoint and pending write of a task's conversation in the app's database as it is made.
- **R1.2** When a task with no run in this process reopens, the task runner shall load its conversation from the database and continue on the same thread.

## R2 · Reopening

- **R2.1** When the user continues a cancelled, failed, interrupted or closed task, the task runner shall reopen it with its source folder and tool-call choice and continue from its last checkpoint, or with a nudge to continue when nothing is pending on the thread.
- **R2.2** When the user sends a message to a task with no run in this process, the task runner shall reopen it and start a turn with that message.
- **R2.3** When the app starts, the event log shall mark the tasks left running as interrupted and leave every conversation open to be continued.

## R3 · Files and containers

- **R3.1** The task runner shall keep every file of a task under `<userData>/tasks/<taskId>/`: the orchestrator's scratch, each delegation's workspace, run directory and snapshot, and each sandbox's workspace and the specialist's output.
- **R3.2** The task container shall bind the task's `scratch` folder writable at `/scratch`.
- **R3.3** The sandbox service shall bind the sandbox's `out` folder writable at `/root/out`.
- **R3.4** When a task is cancelled or closed, or the app quits, the task runner shall stop the task's containers and keep them and their folders.
- **R3.5** When a task reopens, the task runner shall start its stopped containers, or create them again over the same folders when Docker no longer has them, and tell the orchestrator which were created again.
- **R3.6** The sandbox service shall record each sandbox in the database, so a reopened task reaches it by the same id.
- **R3.7** The delegation shall keep its workspace, run directory and snapshot when it ends.

## R4 · Deleting

- **R4.1** When the user deletes a task, the app shall remove its containers, its folder, its patches, its conversation and its records.
- **R4.2** If the user deletes a task that has a turn running, then the app shall refuse and say to cancel it first.
- **R4.3** The app shall delete a task's data only when the user deletes the task.

## Out of scope

- Resuming a Claude Code session cut off mid-delegation; the orchestrator delegates again.
- Keeping the tools installed in a container Docker removed.
- Cleaning up old tasks automatically.
