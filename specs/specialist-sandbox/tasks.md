# Specialist sandbox — tasks

## 1 · The boundary

- [x] 1.1 (Unit) Run a delegation's own container as root with the install capabilities, a writable root and `Bash`, wrapped so its process id is known and the login volume is handed back to uid 1000 — R4.3, R4.6
- [x] 1.2 (Unit) Write the specialist's system prompt for a root shell with full internet access and output kept outside `/work` — R4.7

## 2 · The sandbox service

- [x] 2.1 (Unit) Split the workspace into creating its directories and adding files under a cap, and rebase a snapshot on a patch — R2.1, R2.2, R2.3, R4.5
- [x] 2.2 (Unit) Build a sandbox's `docker run` arguments and create, copy into, run commands in, destroy and sweep sandboxes, with events — R1.1, R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.7, R2.8, R2.9
- [x] 2.3 (Unit) Watch a sandbox's disk after each call and on an interval, and stop it past its limit — R3.1, R3.2, R3.3

## 3 · The specialist in a sandbox

- [x] 3.1 (Unit) Delegate into a sandbox: its workspace, the package's missing files, the ask channel cleared, one delegation at a time, a stop that leaves the sandbox up, the snapshot rebased — R4.1, R4.2, R4.4, R4.5, R4.8

## 4 · The orchestrator

- [x] 4.1 (Unit) Give the orchestrator the four sandbox tools and the `sandbox` field, allow them, and wire the task's sandboxes into its workspace and the start sweep — R5.1, R2.6, R2.7
- [x] 4.2 (Unit) Instruct the orchestrator to prepare sandboxes and leave extraction and analysis to the specialist — R5.2

## 5 · The orchestrator's own container

- [x] 5.1 (Unit) Start the orchestrator's task container with no memory, CPU, process or size limit, its `/scratch` and `/tmp` on the writable root — R6.1, R6.2

## 6 · No limits by default

- [x] 6.1 (Unit) Drop the limits and the copy cap of a delegation's own container, make every sandbox limit optional, and take the limits out of Settings — R7.1, R1.1, R1.5
