---
status: accepted
---

# 0013 · Give the sandboxes full internet access

## Context

adr:0006-run-the-specialist-inside-a-container-per-task routes the specialist's
traffic through an egress proxy, `hfr-egress`, on an internal network, allowing only
the domains Claude Code requires, and
adr:0007-run-the-orchestrators-tools-in-a-task-container runs the orchestrator's task
container with no network. The user decided that a sandbox is a controlled
environment scoped to the analysis — the files the agent can reach — and not a
network jail: the specialist has to download and install the tools an analysis needs,
the orchestrator's own code has to fetch its dependencies, and internet access is
essential to both.

## Decision

Both sandboxes run on Docker's default bridge network with full internet access. The
egress proxy, its image, its allowlist and the internal `hfr-sandbox` network are
removed, and the app removes a proxy container and network an earlier version left
behind. Everything else adr:0006-run-the-specialist-inside-a-container-per-task and
adr:0007-run-the-orchestrators-tools-in-a-task-container confine stays: the copied
files as the only bind mounts, the read-only source, the non-root user, dropped
capabilities, resource limits, and no host path or environment. This supersedes the
egress proxy part of adr:0006-run-the-specialist-inside-a-container-per-task and the
no-network part of adr:0007-run-the-orchestrators-tools-in-a-task-container. Rejected:
widening the allowlist per tool, which the user ruled out as an obstacle to the
analysis.

## Consequences

- Isolation rests on what is mounted. Content inside an analysed artifact that steers
  the agent (prompt injection) can send out the files in `/work` or `/scratch` and the
  specialist's Claude login token on the shared config volume; nothing on the network
  stops it.
- Nothing beyond the files a task needs may ever be mounted into either sandbox.
- A delegation no longer depends on a proxy container being up.
