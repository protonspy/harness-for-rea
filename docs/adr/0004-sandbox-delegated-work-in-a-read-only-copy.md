---
status: superseded
superseded-by: 0006-run-the-specialist-inside-a-container-per-task
---

# 0004 · Sandbox delegated work in a read-only copy

## Context

Delegated analysis must reach only the files its task needs, start read-only, and
never change the user's originals without explicit approval. The host is Windows, so
there is no OS-level sandbox for a spawned process: Claude Code's permission rules
and DeepAgents' backends are policy enforced by the agent runtime, and a `Bash` tool
can step around both. The workspace already ships a dev container
(`.devcontainer/`) that can host command execution.

## Decision

Each task gets its own working directory under the app's data folder, into which the
app copies only the files the context package names. The orchestrator sees it through
a DeepAgents `FilesystemBackend` rooted there; the specialist gets it as `cwd` with
read-only tools (`Read`, `Grep`, `Glob`) and no `Bash`. Changes come back as a patch
against the copy, and the app applies it to the originals only after the user
approves it. Command execution is off by default and, when enabled, runs only inside
a container. Every file read or written is recorded in the task's audit log, and the
directory can be discarded when the task ends. Rejected: running the specialist in
the original repository with deny rules, because a rule is not a boundary; and a
container for every task, because most tasks only read.

## Consequences

- Files outside the copy-in list are unreachable, so a context package that omits a
  needed file produces a weaker answer rather than a wider read.
- Copying large trees costs time and disk; the copy-in list is the lever.
- Patches can conflict with originals that changed during the task; applying one
  checks the base first.
- Enabling commands requires Docker on the host.
