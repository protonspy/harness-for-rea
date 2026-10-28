---
autonomy: auto
ci: wait
---

# Task sandbox — requirements

## Purpose

Every delegation to the specialist runs in its own container, over a copy of only the
files its step needs, mounted at `/work`, and told only the objective of that step.
The specialist never sees the user's original request, the orchestrator's history,
other tasks, or anything of the host beyond those copies; the user's files change
only through an approved patch.

## R1 · Workspace

- **R1.1** When a delegation starts, the sandbox shall create `<userData>/workspace/<uuid>/` with a random UUID and a pristine snapshot of it outside that directory.
- **R1.2** The sandbox shall copy into the workspace only the files the context package names, at their paths relative to the source root, and record the SHA-256 of each.
- **R1.3** If a requested path resolves outside the source root, through `..`, an absolute path, a symbolic link or a junction, then the sandbox shall reject the delegation and record the rejected path.
- **R1.4** Where discard on completion is enabled, the sandbox shall delete the workspace, its run directory and its snapshot when the delegation ends.

## R2 · Container

- **R2.1** The sandbox shall run the specialist in a new container whose only bind mounts are the workspace at `/work`, as the working directory, and the run's rendered system prompt, read-only, outside `/work`.
- **R2.2** While the step is in read mode, the sandbox shall mount `/work` read-only.
- **R2.3** The sandbox shall run the container as a non-root user with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, and memory, CPU and process limits.
- **R2.4** The sandbox shall route the container's network traffic through an egress proxy that allows only the domains Claude Code requires.
- **R2.5** When a delegation is cancelled or exceeds its timeout, the sandbox shall kill its container and record the delegation as cancelled or timed out.
- **R2.6** If Docker is unavailable or the sandbox image fails verification, then the sandbox shall refuse the delegation and report the reason, without running the specialist on the host.

## R3 · Context isolation

- **R3.1** The sandbox shall build the specialist's prompt only from the context package fields: objective, files, excerpts, environment facts, questions, constraints and report format.
- **R3.2** The sandbox shall not pass to the container the user's original request, the orchestrator's conversation, other tasks' data, host paths or host environment variables.
- **R3.3** The sandbox shall start Claude Code with `--setting-sources ""`, `--strict-mcp-config` and a configuration directory on the sandbox's own volume, so no host settings, memory or instructions load.
- **R3.4** The sandbox shall state in the specialist's system prompt that the artifacts in `/work` are owned by the user or authorized for analysis.

## R4 · Changes and audit

- **R4.1** When a step in modify mode completes, the sandbox shall produce a patch from the difference between the workspace and its snapshot.
- **R4.2** The sandbox shall apply a patch to the original files only after patch approval.
- **R4.3** If an original file's SHA-256 differs from the one recorded at copy time, then the sandbox shall refuse to apply the patch and report the conflicting files.
- **R4.4** The sandbox shall record as events every file copied in, every file the specialist read or wrote, and every patch proposed, approved, rejected or applied.

## Out of scope

- Running commands other than the Claude Code CLI inside the container.
- Linux and macOS hosts.
