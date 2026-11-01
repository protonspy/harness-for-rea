---
autonomy: auto
ci: wait
branch: feat/specialist-sandbox
delivery: in-review
pr: 6
---

# Specialist sandbox — requirements

## Purpose

The orchestrator prepares the place the specialist works in: it creates a sandbox, with
no limit unless it sets one on CPUs, memory, disk or processes, copies files from the task's source folder and its
own scratch into the sandbox's `/work`, runs commands in it as root and installs what the
analysis needs, then delegates the specialist into it, where the specialist has a shell of
its own (adr:0016-let-the-orchestrator-run-the-specialists-sandbox). It exists so the
specialist, not the orchestrator, does the extraction and the analysis.

## R1 · Creating a sandbox

- **R1.1** When the orchestrator creates a sandbox, the sandbox service shall start a container `hfr-sbx-<id>` from the specialist image with the CPU, memory and process limits the orchestrator set and return the sandbox's id.
- **R1.2** The sandbox service shall run the sandbox's container as `root:root` with a writable root filesystem, `no-new-privileges`, every capability dropped but `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID` and `KILL`, on Docker's default network.
- **R1.3** The sandbox service shall bind into the sandbox only its workspace, writable at `/work`, its run directory, read-only at `/run/hfr`, and its ask channel, besides the shared login volume, and never `--privileged`, the Docker socket or another host path.
- **R1.4** If Docker refuses the limits or cannot start the container, then the sandbox service shall return Docker's reason to the orchestrator and keep nothing of the sandbox.
- **R1.5** When the orchestrator leaves a limit out, the sandbox service shall start the sandbox without that limit, and without a disk watch when it leaves out the disk.

## R2 · Controlling a sandbox

- **R2.1** When the orchestrator copies files into a sandbox, the sandbox service shall copy each file named from the task's source folder to `/work/<path relative to the source folder>`, recording its SHA-256 in the sandbox's snapshot, and each file named from the orchestrator's scratch to `/work/.orchestrator/<path under the scratch>`.
- **R2.2** If a file named for copying resolves outside the source folder and the scratch, then the sandbox service shall copy nothing of that call and return the rejected path.
- **R2.3** If the files copied into a sandbox would pass the disk limit the orchestrator set, then the sandbox service shall copy nothing of that call and return the limit.
- **R2.4** When the orchestrator runs a command in a sandbox, the sandbox service shall run it as root with `sh -c` in `/work`, stop it at the time limit the orchestrator gives, up to a day, or ten minutes, and return its exit code and output, truncated to the orchestrator's output cap.
- **R2.5** When the orchestrator destroys a sandbox, the sandbox service shall remove its container and, where discard on completion is enabled, its workspace, run directory and snapshot.
- **R2.6** When a task ends, the sandbox service shall destroy every sandbox the task created.
- **R2.7** When the app starts, the sandbox service shall remove every `hfr-sbx-` container a previous run left behind.
- **R2.8** If the orchestrator names a sandbox that does not exist, belongs to another task, or was stopped, then the sandbox service shall refuse the call and say which.
- **R2.9** The sandbox service shall record as events every sandbox created, every copy, every command run, every sandbox stopped and every sandbox destroyed.

## R3 · Disk limit

- **R3.1** The sandbox service shall measure a sandbox's disk use as the size of its container's writable layer plus the size of its workspace.
- **R3.2** Where the orchestrator set a sandbox's disk limit, the sandbox service shall measure its disk use after every copy, every command and every delegation in it, and at a fixed interval while it runs.
- **R3.3** If a sandbox's disk use passes the disk limit the orchestrator set, then the sandbox service shall stop its container, record the use and the limit, and refuse every later call naming it with that reason.

## R4 · The specialist in a sandbox

- **R4.1** When the orchestrator delegates into a sandbox, the delegation shall copy into the sandbox's `/work` every file of the context package not already there and run the specialist inside that container with `docker exec`, leaving the sandbox running when the specialist ends.
- **R4.2** If a delegation names a sandbox that is already running a delegation, then the delegation shall be refused.
- **R4.3** The delegation shall start the specialist as root with `Bash` besides `Read`, `Grep` and `Glob`, and `Edit` and `Write` in modify mode, still restricted, with no setting source and every permission prompt denied.
- **R4.4** When a delegation into a sandbox is cancelled or times out, the delegation shall stop the specialist's process and leave the sandbox running.
- **R4.5** When a modify-mode delegation into a sandbox proposes a patch, the delegation shall take the workspace as it stands as the snapshot later patches from that sandbox are made against.
- **R4.6** When the specialist ends, the delegation shall give the login volume back to the non-root user the login container runs as.
- **R4.7** The specialist's system prompt shall state that it runs as root with a shell and full internet access, may install tools, and keeps everything it extracts or builds outside `/work`.
- **R4.8** When a delegation starts in a sandbox, the delegation shall clear the questions and answers an earlier delegation left on its ask channel.

## R5 · The orchestrator

- **R5.1** The orchestrator shall have `sandbox_create`, `sandbox_copy`, `sandbox_exec` and `sandbox_destroy`, and an optional `sandbox` on `delegate_to_specialist`.
- **R5.2** The orchestrator's instructions shall have it size and configure a sandbox for the task, set up the whole scenario in it with any command as root — installing tools, unpacking, laying out files — leave the analysis of the target to the specialist, and destroy a sandbox it no longer needs.

## R6 · The orchestrator's own container

- **R6.1** The task runner shall start the orchestrator's task container with no memory, CPU or process limit.
- **R6.2** The task runner shall keep the orchestrator's `/scratch` and `/tmp` as folders on the task container's writable root filesystem, with no size limit.

## R7 · A delegation's own container

- **R7.1** Where a delegation names no sandbox, the delegation shall copy the package's files into its workspace with no size cap and run its container with no memory, CPU, process or size limit.

## Out of scope

- A ceiling on the limits the orchestrator chooses, in Settings or anywhere else.
- Copying from any host path but the task's source folder.
- A disk limit for a delegation that names no sandbox, or for the orchestrator's own task container.
