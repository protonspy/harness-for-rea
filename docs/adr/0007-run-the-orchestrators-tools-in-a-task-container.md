---
status: accepted
---

# 0007 · Run the orchestrator's tools in a task container

## Context

adr:0001-use-deepagents-on-openrouter-for-orchestration left the orchestrator's tools in
the Electron main process: DeepAgents read the source folder through a `FilesystemBackend`
on the host, and its `execute` tool had no backend that could run a command. The user asked
for every agent to run in a sandbox, with the orchestrator seeing the whole source folder
through a local bind and the specialist seeing only the workspace prepared for its step,
under adr:0006-run-the-specialist-inside-a-container-per-task. The user also asked that
the orchestrator write the prompt handed to the specialist: a brief stating the background
and purpose of the step, in the orchestrator's words, instead of a prompt assembled only
from structured fields. DeepAgents provides `BaseSandbox`, a backend whose file tools and
`execute` all run through one `execute(command)` call, so a container can stand behind it.

## Decision

Each task starts one container, `hfr-orch-<task>`, from the specialist image, with the
source folder bind-mounted read-only at `/workspace`, no network, a non-root user, every
capability dropped, `no-new-privileges`, a read-only root and resource limits. The
orchestrator's `ls`, `read_file`, `glob`, `grep` and `execute` run in it through a
`BaseSandbox` over `docker exec`; uploads are refused, so nothing the orchestrator does
writes the user's files. The container is removed when the task ends. The agent loop and
its calls to OpenRouter stay in the main process. The context package gains a `brief`
written by the orchestrator; the sandbox replaces any host or `/workspace` path in it with
`/work`, and renders it first in the specialist's prompt. Rejected: running the whole
orchestrator in a container, which would move the event log, approvals and the app's IPC
across a container boundary for no gain in isolation of the user's files; and a writable
bind, which would let `execute` change the originals without patch approval.

## Consequences

- Docker is required to start a task, not only to delegate.
- `execute` becomes available to the orchestrator, confined to a networkless container;
  build or test commands that need to write fail on the read-only bind.
- The specialist's prompt now carries free text from the orchestrator, so R3.2 of
  `specs/task-sandbox/` holds by scrubbing rather than by construction; the user's request
  can reach the specialist as far as the orchestrator restates it.
- The brief must state the real purpose and ownership; the orchestrator's system prompt
  forbids inventing either.
