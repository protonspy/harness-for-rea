# Specialist sandbox — design

## What changes

Serves R1.1–R5.2, under adr:0016-let-the-orchestrator-run-the-specialists-sandbox.

- `src/main/sandbox/specialistbox.ts` (new) — `sandboxArgs`, the `docker run -d` arguments
  of a sandbox (R1.1–R1.3), and `SpecialistBoxes`, one per task: `create`, `copy`, `run`,
  `destroy`, `disposeAll`, the disk watch and `sweep` (R1.4–R3.3). It runs `docker`
  through the same `ExecBuffer` as the task container, so tests stub it.
- `src/main/sandbox/workspace.ts` — `prepareWorkspace` splits into creating the
  directories (`createWorkspace`) and `addFiles`, which a sandbox's copy calls with its own
  disk limit as the cap; `rebaseSnapshot` takes a patch's contents as the new snapshot (R4.5).
- `src/main/sandbox/docker.ts` — the boundary: the delegation's own container runs as root
  with the install capabilities (moved here from `taskbox.ts`) and a writable root
  filesystem; `claudeArgs` adds `Bash`; `specialistCommand` wraps the CLI in `sh` so its
  process id is known for a stop and the login volume is handed back to uid 1000 after it
  ends (R4.3, R4.4, R4.6). `execArgs` is the `docker exec` into a sandbox. The login
  container stays non-root.
- `src/main/delegation.ts` — `delegate` takes an optional sandbox: its workspace instead of
  a fresh one, the package's missing files copied in, the ask channel cleared, the busy
  flag held, no discard at the end, and the snapshot rebased after a patch (R4.1, R4.2,
  R4.5, R4.8). `Launcher.launch` gains the sandbox's container name.
- `src/main/orchestrator/tools.ts`, `agent.ts` — the four tools, the `sandbox` field, the
  allowlist and the instructions (R5.1, R5.2).
- `src/main/orchestrator/runner.ts`, `src/main/index.ts` — the task workspace carries the
  task's `SpecialistBoxes`, disposed with it; the sweep runs at start (R2.6, R2.7).
- `src/main/sandbox/prompt.ts` — the specialist's system prompt (R4.7).

## Boundaries and contracts

The sandbox boundary of `project.md` moves, as the ADR records: root, the seven install
capabilities, a writable root filesystem and `Bash`, for both the sandbox and a delegation's
own container. Mounts do not grow: a sandbox binds exactly what a delegation's container
binds. `/tmp` in a sandbox is not a tmpfs, so what is written there counts toward its disk.

A stop of a specialist inside a sandbox cannot kill the container, which outlives it: the
wrapper writes the CLI's process id to `/tmp/hfr-claude.pid`, and the stop kills that
process with `docker exec`. The CLI keeps the wrapper's stdin through `<&0`, since a
non-interactive `sh` gives a background job `/dev/null`.

## Alternatives considered

Running a delegation without a sandbox through a temporary `SpecialistBoxes` sandbox would
leave one code path, but every delegation test would then need a stubbed Docker; the
delegation's own `docker run` stays, with the sandbox's user, capabilities and tools.

## Risks

- Disk is enforced every 15 s and after each call, so a fast writer passes the limit by what
  it writes in between; `docker kill` then stops it.
- The snapshot rebase takes a rejected patch's contents as the base, so a later patch from
  the same sandbox conflicts on apply rather than reverting the rejected change silently.
