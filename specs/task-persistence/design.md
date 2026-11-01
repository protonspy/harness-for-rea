# Task persistence — design

## What changes

Serves R1.1–R4.3, under adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted.

- `src/main/db.ts` — a second migration: `checkpoints` and `checkpoint_writes`, keyed by thread,
  namespace and id with the serialized blobs `MemorySaver` keeps, and `sandboxes` (id, task, limits).
  All three cascade from `tasks`.
- `src/main/orchestrator/checkpoint.ts` (new) — `SqliteSaver extends MemorySaver`: `put` and
  `putWrites` call the parent, then store what the parent just stored; `getTuple`, `list` and
  `getDeltaChannelHistory` first load the thread into the parent's maps once; `deleteThread`
  deletes both (R1.1, R1.2). LangGraph's logic for what a checkpoint holds stays the parent's.
- `src/main/orchestrator/runner.ts` — `start` splits into creating the task and `open`, which
  builds the live run (model, tool context, workspace, agent) for a task that already exists.
  `continueTask` and `sendMessage` reopen a task with no live run (R2.1, R2.2); `remove` deletes one
  (R4). `end` stops the workspace instead of removing it (R3.4).
- `src/main/events/log.ts` — `recover` leaves conversations open (R2.3); `deleteTask` removes the
  rows and the task's folder (R4.1).
- `src/main/sandbox/taskbox.ts` — no `--rm`; `/scratch` binds `tasks/<id>/scratch`; `start` runs
  `docker start` on a container that exists and `docker run` otherwise; `stop` and `remove` replace
  `dispose` (R3.2, R3.4, R3.5).
- `src/main/sandbox/specialistbox.ts` — sandboxes recorded in `sandboxes` and loaded for a reopened
  task; a sandbox is brought up on first use after a reopen (`docker start`, or `docker run` over the
  same folders); `/root/out` binds `tasks/<id>/outputs/<sandbox>`; `stopAll` replaces
  `disposeAll` at a task's end, `removeAll` runs at its deletion (R3.3–R3.6).
- `src/main/delegation.ts` — workspaces under the task's folder, never discarded (R3.1, R3.7);
  `discardOnCompletion` leaves Settings, the IPC contract and the Settings view.
- `src/shared/api.ts`, `src/main/index.ts`, `src/renderer/src/views/TaskView.tsx` — `continueTask`
  and `deleteTask`, with their buttons; the composer stays open on a closed task.

## Data

`checkpoints(thread_id, ns, id, parent_id, checkpoint BLOB, metadata BLOB)` and
`checkpoint_writes(thread_id, ns, checkpoint_id, task_id, idx, channel, value BLOB, task_path)`
mirror `MemorySaver.storage` and `MemorySaver.writes` row for row; the thread id is the task id.

## Risks

- `MemorySaver` keeps its maps as plain objects; the subclass depends on their shape, which a
  LangGraph upgrade can change. The round-trip test fails on such an upgrade.
