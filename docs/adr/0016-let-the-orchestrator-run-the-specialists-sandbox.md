---
status: accepted
---

# 0016 · Let the orchestrator run the specialist's sandbox

## Context

adr:0006-run-the-specialist-inside-a-container-per-task gives every delegation a fresh
container that lives exactly as long as the Claude Code process: a non-root user, every
capability dropped, a read-only root filesystem, and only `Read`, `Grep` and `Glob` (plus
`Edit` and `Write` in modify mode). In a real task the orchestrator concluded "the
specialist sandbox has no shell — only file reading", so it unpacked and dumped the target
itself and handed the specialist text to interpret, which is the analysis
adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code sends to the
specialist. The user decided that the sandbox must run as `root:root`, that the
orchestrator sets its CPU, memory and disk, copies files from the task's source folder into
its workspace, runs any command in it and installs dependencies, and that the specialist
works in the sandbox the orchestrator prepared. adr:0015-run-the-task-container-as-root
already gave the orchestrator's own container the same freedom. Docker Desktop on this host
uses the containerd snapshotter, which accepts `--storage-opt size=` and ignores it (a
container capped at 1 GB wrote 1.5 GB), while `docker container inspect --size` reports the
writable layer's size.

## Decision

The orchestrator creates a sandbox with no limit unless it sets one: CPUs, memory, disk and
processes are each optional, and none comes from the app. A sandbox is a long-lived
container, `hfr-sbx-<id>`, from the specialist image: root, a writable root filesystem,
`no-new-privileges`, every capability dropped but those installing packages needs (the set
of adr:0015-run-the-task-container-as-root), Docker's default network, the shared login
volume, and three binds: `workspace/<id>/` writable at `/work`, `runs/<id>/` read-only at
`/run/hfr`, and its ask channel. It is never `--privileged`, never gets the Docker socket
and never another host path. The orchestrator copies files into `/work` only from the
task's source folder and from its own scratch, runs commands in the sandbox as root, and
delegates into it, one delegation at a time; the sandbox outlives each delegation and is
removed when the orchestrator destroys it or the task ends. The specialist runs as root
with `Bash` besides its file tools, still `--restricted` with no setting source and every
permission prompt denied; a delegation that names no sandbox gets a container of its own
with the same user, capabilities and tools, and, as the user ruled the sandboxes too
limited, no memory, CPU, process or size limit and no cap on the files copied into it;
the limits leave Settings. A disk limit the orchestrator sets is enforced by watching: the
app adds the writable layer's size to the workspace's and stops the sandbox once the total
passes its limit. After every specialist run the login volume is handed back to the
non-root user the login container runs as. The orchestrator's own task container
(adr:0015-run-the-task-container-as-root) loses every limit: no memory, CPU or process
limit, and its `/scratch` and `/tmp` move from size-capped tmpfs mounts to folders on its
writable root, on Docker's disk rather than in memory, since the user ruled that the
orchestrator's sandbox has no limit. Rejected: a `--storage-opt` quota, ignored on
this Docker; a tmpfs `/work`, which spends the host's memory as disk and leaves the rest of
the filesystem unbounded; a ceiling in Settings, which the user declined; copying from any
host path, which a container with full internet access
(adr:0013-give-the-sandboxes-full-internet-access) could send anywhere.

## Consequences

- The login volume, with the subscription token, is mounted in every sandbox from its start.
  The specialist can read it with its shell, and so can the orchestrator's model through
  `sandbox_exec`, whose output goes to OpenRouter; the redaction of known secret shapes masks
  a plain read, not a deliberate one, and full internet access already lets either send it
  anywhere. The exposure is accepted for now; handing the token to a sandbox only for the
  length of a delegation is the change that would narrow it.
- A disk limit is enforced after the fact: a sandbox can pass its limit by what it writes between
  two checks before it is stopped.
- The orchestrator can analyse the target with `sandbox_exec` as it could with `execute`;
  only its instructions send that work to the specialist.
- In modify mode every file left in `/work` that was not copied in becomes an added file of
  the patch, so both agents are told to keep their own output outside `/work`.
- A container escape starts from root with seven capabilities in the specialist's
  container too.
- Every container the app starts, but the login container, can take all of Docker's
  memory, CPUs and disk unless the orchestrator limited its sandbox; a runaway process is
  stopped by Docker Desktop's own VM limits, by `sandbox_destroy` or by ending the task.
- A large target goes from the source folder to the workspace whole, on the app's data
  disk, as many times as it is delegated without a sandbox.
