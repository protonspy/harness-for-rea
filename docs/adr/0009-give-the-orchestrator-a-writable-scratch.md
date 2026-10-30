---
status: accepted
---

# 0009 · Give the orchestrator a writable scratch

## Context

The harness divides the work: the specialist reasons about the target's code, and the
orchestrator dispatches, organises files and writes code that builds on the
specialist's findings — scripts it runs to test a hypothesis, probes, small tools
(specs/chat R6). adr:0007-run-the-orchestrators-tools-in-a-task-container gave the
orchestrator a container with the source bind-mounted read-only and a read-only root,
so `execute` can read and run against the source but can write nowhere. That is what
keeps the user's files unchanged without patch approval, and it must stay. But code
the orchestrator writes to test a hypothesis has nowhere to live or run, and the
read-only source mount is deliberately not that place.

## Decision

The orchestrator's container gains one writable mount, `/scratch`, a per-task
directory under the app's data folder (or a tmpfs where the experiment needs no
persistence), separate from the read-only source bind and from `/work`. `execute`
writes and runs there; the source mount stays read-only and uploads stay refused, so
nothing the orchestrator runs can change the user's files. The scratch is removed with
the task's container. A change to the user's source remains a specialist patch through
the existing approval (specs/chat R6.4). Rejected: making the source mount writable,
which would let `execute` change the originals with no approval and defeat
adr:0007-run-the-orchestrators-tools-in-a-task-container; and writing experiments into
`/work`, which is the specialist's prepared workspace, not the orchestrator's.

## Consequences

- `src/main/sandbox/docker.ts` adds the `/scratch` mount for the orchestrator
  container; this is a change to the sandbox boundary and is tested as one.
- The orchestrator can run code with real side effects within the container — files,
  processes — but still no network (the container keeps adr:0007's no-network rule),
  so an experiment cannot reach out.
- Scratch contents are the orchestrator's working state, not evidence; what it carries
  into its answer is still tied to files and lines like any other claim.
- The scratch is per task and discarded with it; nothing an experiment writes
  survives, which a later task must not depend on.
