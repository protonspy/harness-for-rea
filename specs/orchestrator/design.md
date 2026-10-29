# Orchestrator — design

## What changes

Serves R1.1, R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.7, R3.1, R3.2, R3.3, R3.4, R3.5.

`src/main/orchestrator/` builds one DeepAgents agent per task, following
`study-lab/src/main/harness/{model,agent}.ts` and
adr:0001-use-deepagents-on-openrouter-for-orchestration.

- **Model** — `ChatOpenRouter` with `model`, `models: [model, fallback]`,
  `provider: { data_collection: "deny" }`. A callback on `handleLLMEnd` reads
  `llmOutput.tokenUsage` (OpenRouter's `usage`, including `cost`) into an event.
- **Files and commands** — a `BaseSandbox` over `docker exec` into `hfr-orch-<task>`,
  the source folder bind-mounted read-only at `/workspace` with no network
  (adr:0007-run-the-orchestrators-tools-in-a-task-container). `ls`, `read_file`,
  `glob`, `grep` and `execute` run there; uploads are refused and a `deny`
  permission covers writes. Tests pass a `FilesystemBackend` in its place.
- **Brief** — the context package's `brief` is the orchestrator's own prompt for the
  step: background and real purpose, never an invented authorization.
- **Delegation** — `delegate_to_specialist` takes a context package
  (`src/shared/context.ts`, zod) and calls the sandbox
  (`specs/task-sandbox/`), which prepares the workspace and runs the specialist
  (`specs/claude-specialist/`). It returns the report, the evidence lines and, in
  modify mode, a patch id with its diff stat.
- **Approval** — `apply_patch({ patchId })` is in `interruptOn` with
  `allowedDecisions: ["approve", "reject"]`. The run pauses with `__interrupt__`;
  the task goes to `waiting` and the UI shows the patch. The user's decision
  resumes it with `new Command({ resume: { decisions: [{ type }] } })` on the same
  `thread_id`, held by a `MemorySaver` that lives as long as the app.
- **Steps** — `write_todos` calls are read from the tool callbacks into `todo`
  steps; each delegation is a `delegation` step.

## Alternatives considered

A SQLite-backed checkpointer would let a paused run survive a restart. Rejected for
now: the run would also need the sandbox's live state back, and a restart already
marks the task interrupted (`specs/event-log/` R3.1); a retry is the recovery.
