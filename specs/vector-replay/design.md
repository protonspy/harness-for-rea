# Vector replay — design

## What changes

Serves R1.1–R2.5, with a delta to `specs/analysis-contract/` (the contract carries vectors).

- `src/shared/contract.ts` — `vectors: [{ name, args, stdin, stdout, exitCode, source }]`, every list
  default empty, `source` required (R1.2). `CONTRACT_SHAPE` shows it.
- `src/main/sandbox/prompt.ts` — the contract instructions say vectors come only from running the
  original, `source` naming the command run (R1.1).
- `src/main/orchestrator/replay.ts` (new) — `replayCommand(command, vector)`: the shell line that runs
  the orchestrator's command with each argument and the standard input decoded from base64 inside
  the line, so nothing from a vector is parsed as shell (R2.5), stderr discarded so stdout compares
  alone; `compare(vector, output, exitCode)`: pass, or what differed (R2.2).
- `src/main/orchestrator/tools.ts` — `replay_vectors({ analysis, command })`: finds the analysis in
  the task's steps or its project's, reads the contract's vectors (R2.4), runs each through
  `ctx.run`, returns the outcomes and logs `vectors.replayed` with the counts (R2.1, R2.3).
- `src/main/orchestrator/runner.ts` — `ctx.run` is the task container's `execute` when the backend
  has one; tests give a fake.
- `src/main/orchestrator/agent.ts` — the tool is on the orchestrator's allowlist, named in its
  instructions for checking a reimplementation.
