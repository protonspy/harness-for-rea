---
status: accepted
---

# 0014 · Run the task container as root

## Context

adr:0007-run-the-orchestrators-tools-in-a-task-container runs the orchestrator's task
container as the non-root `agent` user, with every capability dropped and a read-only
root filesystem; adr:0009-give-the-orchestrator-a-writable-scratch adds `/scratch` as
its one writable place. In a real run the orchestrator's code needed `unzip` and
`python3`, and `apt-get install` failed with "are you root?". The user decided that a
sandbox is a controlled environment scoped to the analysis, free to install any tool
(adr:0013-give-the-sandboxes-full-internet-access); what keeps the user's files safe
is the read-only bind of the source, not the container's user.

## Decision

The task container runs as root, with a writable root filesystem and Docker's default
capabilities, so the orchestrator can install packages with `apt-get` and anything
else its code needs. It keeps `no-new-privileges`, its resource limits, and the source
folder bind-mounted read-only and recursively so; it is never `--privileged` and never
gets the Docker socket or any other host path. The container and everything installed
in it are removed with the task. Rejected: installing into the user's space only,
which leaves out every tool that comes as a system package; and baking a fixed tool set
into the base image, which cannot guess what an analysis will need.

## Consequences

- Root in the container cannot write the source: the bind is read-only for root too.
- A container escape now starts from root inside the container, with Docker's default
  capabilities, rather than from an unprivileged user.
- What the orchestrator installs lasts for the task only; a later task starts clean.
- The specialist's container is unchanged here; it gains the same freedom with its
  shell under specs/rea-native.
