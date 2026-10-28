---
autonomy: auto
ci: wait
branch: feat/harness-for-rea
delivery: in-review
pr: 1
---

# Orchestrator — requirements

## Purpose

The orchestrator takes the user's software engineering task, decomposes it, reads
the source tree to decide what each step needs, delegates deep analysis to the
specialist with a context package, asks the user before any patch is applied, and
consolidates the results into one answer. Decided in
adr:0001-use-deepagents-on-openrouter-for-orchestration.

## R1 · Model

- **R1.1** The orchestrator shall run `createDeepAgent` on `ChatOpenRouter` with the model the user chose, defaulting to `deepseek/deepseek-v4.1-flash-1017`, with `z-ai/glm-5.3-flash` offered as a preset and sent as the fallback in OpenRouter's `models` routing.
- **R1.2** The orchestrator shall send every OpenRouter request with `provider.data_collection` set to `deny`.
- **R1.3** When a model call completes, the orchestrator shall record its tokens, its cost from OpenRouter's usage and the model that answered as an event, and add them to the task's totals.
- **R1.4** If OpenRouter rejects the key, reports no credits or rate-limits the request, then the orchestrator shall fail the task with a message the user can act on.

## R2 · Decomposition and delegation

- **R2.1** When a task starts, the orchestrator shall decompose it with `write_todos` and record each todo list change as steps and an event.
- **R2.2** The orchestrator shall run its file and command tools in a container for the task, with the source folder bind-mounted read-only at `/workspace`, no network, and the container removed when the task ends.
- **R2.3** The orchestrator shall expose the specialist as a `delegate_to_specialist` tool whose input is a context package validated against its schema.
- **R2.4** When the agent delegates a step, the orchestrator shall run the delegation in the sandbox and return the specialist's report, its evidence and any proposed patch to the agent.
- **R2.5** If a context package fails validation or the sandbox refuses the delegation, then the orchestrator shall return the reason to the agent as a tool error instead of failing the task.
- **R2.6** The orchestrator shall redact secret shapes from the specialist's report before returning it to the model.
- **R2.7** The orchestrator shall write for each delegation a brief stating the background and real purpose of the step, without claiming ownership or purpose the user's request does not support.

## R3 · Approval and lifecycle

- **R3.1** The orchestrator shall interrupt before `apply_patch` runs and wait for the user's patch approval or rejection.
- **R3.2** When the user approves or rejects a patch, the orchestrator shall resume the run from its checkpointer with that decision.
- **R3.3** When the run ends, the orchestrator shall record its consolidated answer as the task's result.
- **R3.4** When the user cancels a task, the orchestrator shall abort the model call and every running delegation and mark the task cancelled.
- **R3.5** When the user retries an interrupted or failed task, the orchestrator shall start a new run from the same request and source folder.

## Out of scope

- Resuming a run's exact checkpoint after the app restarts; a retry starts over.
