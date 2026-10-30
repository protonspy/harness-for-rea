# Chat — design

## What changes

Serves R1–R7. The task stops being one request with one answer and becomes a
conversation: `src/main/orchestrator/runner.ts` keeps a task's agent, thread and
container alive across turns, and the renderer's `TaskView` becomes a chat surface.
Two changes cross the sandbox boundary the project guards and each gets an ADR; the
rest is lifecycle and UI.

## Turn lifecycle (R1, R2, R3)

`TaskRunner` today runs one `drive()` per task and disposes the workspace on done.

- A turn that ends with no interrupt leaves the task `awaiting-user`, keeping the
  `Live` entry, the thread and the container. `sendMessage(taskId, text)` with no
  live turn starts a new `drive()` with `{ messages: [new HumanMessage(text)] }` on
  the same `thread_id`; the checkpointer resumes the prior state (R1.1, R1.2, R1.4).
- **Mid-turn messages** — the `Live` entry gains an inbox. A langchain middleware
  `beforeModel` hook drains the inbox into user messages before each model call and
  records a `message.read` event (R2.1, R2.2). The inbox is the orchestrator's only;
  a running delegation is not interrupted (R2.3). A rejected gated call resumes with
  `jumpTo: model`, past every `beforeModel` hook, so what the user wrote while the turn
  waited rides on the rejection's message instead (n-0007). A message sent during the
  turn's last model call opens the next turn rather than waiting for one.
- **Stop** reuses the abort controller but is non-terminal: the turn is marked
  `stopped`, delegations abort, and `continueTurn(taskId)` starts a turn that resumes
  from the checkpoint (R3.1, R3.2). A stop the stream does not observe within a bound
  still settles the turn (R3.3), as `cancel` does now.
- The container is disposed on explicit close (`closeTask`, from awaiting-user or
  stopped), on cancel, or at app quit — not at the end of a turn. At startup a task left
  awaiting the user is closed with its answer kept; one left stopped is interrupted.

## Approval and questions (R4, R5)

- **Gated tools** — `interruptOn` is built from the task's chosen tool set rather than
  the fixed `apply_patch`, each with `allowedDecisions: ["approve", "edit", "reject"]`; `apply_patch` takes
  approve or reject only, since a patch is decided as the specialist proposed it.
  The pending-decision machinery in `runner.ts` already carries one decision per
  action request; it extends to carry `edited_action` for edit and `message` for
  reject, resumed with `new Command({ resume: { decisions } })` (R4.1–R4.4). The
  approval timeout rejects a stale call with origin `timeout` (R4.5).
- **The orchestrator's question** — an `ask_user` tool returns a promise held in the
  `Live` entry beside the patch pending-list; the UI answers over IPC and the promise
  resolves, so no checkpoint resume is needed. Timeout resolves the default (R5.1,
  R5.4, R5.5).
- **The specialist's question** — the specialist runs in a networkless container
  (adr:0006-run-the-specialist-inside-a-container-per-task). It asks over a file
  channel in the run directory, which is already bind-mounted; see
  **adr:0008-ask-the-user-from-the-specialist-over-the-run-channel** (R5.2). Kinds,
  reason, default and the cap are shared by both tools in `src/shared/` (R5.3, R5.5).

## The division of labour (R6)

- The orchestrator's system prompt (`agent.ts`) delegates every analysis to the
  specialist and forbids the orchestrator from stating conclusions about code it only
  read (R6.1).
- The orchestrator writes and runs code on the specialist's findings in a writable
  scratch separate from the read-only source mount; see
  **adr:0009-give-the-orchestrator-a-writable-scratch**. Source stays read-only, and a
  change to it is still a specialist patch through the existing approval (R6.2–R6.4).
- A middleware in `agent.ts` holds the orchestrator to an allowlist: `write_todos`, `ls`,
  `glob`, `read_file`, `grep`, `write_file`, `edit_file`, `execute`,
  `delegate_to_specialist`, `propose_patch`, `apply_patch` and `ask_user`. It hides every
  other tool — DeepAgents' `task` subagent and `delete` among them — from the model and
  refuses a call to one. The orchestrator is a coding assistant that reads the user's
  code to write and integrate its own; the instructions send every analysis of the
  target to the specialist, which does the reverse engineering; see
  **adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code** (R6.5).
- `propose_patch` reads the named files out of `/scratch`, resolves each target with
  `resolveTarget`, and writes a patch the way `makePatch` does, base hashes taken from
  the originals now; it is recorded under a `patch` step of the orchestrator, and
  `apply_patch` then takes it through the same approval (R6.6).
- A delegation's `files` may name files under `/scratch`; `delegate_to_specialist` reads
  them out of the task container and `prepareWorkspace` writes them under `.orchestrator/`
  in the workspace, outside the snapshot and its manifest, and `makePatch` leaves that
  folder out, so what the orchestrator prepared reaches the specialist and never the
  source (R6.7).

## IPC (R7)

`src/shared/api.ts` gains, each with its zod schema: `sendMessage(taskId, text)`,
`stopTurn(taskId)`, `continueTurn(taskId)`, `closeTask(taskId)`,
`decideTool(taskId, callId, decision)` carrying `args` for edit and `message` for reject,
and `answerQuestion(taskId, questionId, answer)`. `startTask` gains the chosen gated-tool
set; `getTask` carries the turn state derived from the checkpointer (R1.5). The renderer renders messages, tool-call
cards, an approve/edit/reject card and a per-kind question card, keeps the message box
enabled while a turn runs, and shows stop, continue and your-turn controls (R7.1–R7.5).
The conversation is folded from the event log by a pure function in
`src/renderer/src/lib/chat.ts`, so live and reopened tasks render alike.

The surface is built from shadcn/ui components on Radix, kept as source in
`src/renderer/src/components/ui/`, and the theme moves to shadcn/ui's token names; see
**adr:0010-build-the-renderer-on-shadcn-ui-and-radix**.

## Alternatives considered

- **The specialist asks over a local socket** rather than the run-channel file —
  rejected in adr:0008 for a second reason the file channel avoids: a socket is
  another thing to confine in the container.
- **A SQLite checkpointer** so a continued turn survives a restart — rejected as in
  specs/orchestrator: the sandbox's live state does not survive the restart either,
  and a stopped turn across a restart becomes a retry.
