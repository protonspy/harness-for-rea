---
status: accepted
---

# 0006 · Run the specialist inside a container per task

## Context

adr:0004-sandbox-delegated-work-in-a-read-only-copy ran the specialist on the host
with the task directory as `cwd` and kept containers for command execution only. On
Windows that leaves the specialist's process with the user's account: tool
restrictions and `--setting-sources ""` are policy, not a boundary, and the host's
paths, username and environment are visible to anything it runs. The user asked for
each delegation to run inside a sandbox mounted as `workspace/<uuid>/:/work/`, seeing
only the objective of its own step. Claude Code publishes a reference dev container
with a default-deny egress firewall for this kind of isolation, and lists the
domains it needs in its network requirements. Docker Desktop is installed on the
host but was not running when this was decided.

## Decision

Every delegation runs the pinned Claude Code CLI in a fresh Linux container. The
host directory `<userData>/workspace/<uuid>/`, holding only the copied files, is mounted
at `/work`, read-only unless the step is in modify mode; the only other bind mount is
the run's rendered system prompt, read-only and outside `/work`.
Login state lives in a named volume shared by those containers, never in the user's
`~/.claude`. The container runs as a non-root user with every capability dropped,
`no-new-privileges`, a read-only root filesystem and resource limits, and reaches
the network only through an egress proxy that allows Claude Code's required domains.
The CLI is baked into an image built from a Dockerfile in this repository, pinned by
version and verified against the signed release manifest. If Docker is unavailable
the app refuses to delegate rather than falling back to the host. Rejected: the host
process of adr:0004-sandbox-delegated-work-in-a-read-only-copy, for the reasons
above; and the reference `init-firewall.sh` inside the agent container, because it
needs `NET_ADMIN` and `NET_RAW` in the very container being confined.

## Consequences

- Docker Desktop is a hard requirement for delegation.
- The specialist runs the Linux build of the CLI; the Windows binary verification in
  adr:0002-run-the-specialist-through-the-pinned-claude-code-cli no longer applies
  to it, and verification moves to the image build.
- Subscription login happens inside a container, and the login volume is readable
  by every specialist run.
- Container start adds seconds to each delegation.
- The copy-in workspace, patch approval, audit log and discard of
  adr:0004-sandbox-delegated-work-in-a-read-only-copy carry over unchanged.
