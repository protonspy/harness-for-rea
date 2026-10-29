# Claude specialist — design

## What changes

Serves R1.1, R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3, R2.4, R2.5, R3.1, R3.2.

`src/main/specialist/` ports `study-lab/src/main/claude/{stream,service,account}.ts`
with the size caps and subagent attribution of MagnoTech's `leitorDoStream.ts`.
What changes from both references is where the process runs: the executor never
picks a binary. It receives a `Launch` — program, arguments, working directory and
environment — from the sandbox (`docker run … claude -p …`, see
`specs/task-sandbox/`), spawns that without a shell, and reads stdout line by line.
Tests hand it a `Launch` for `tests/fixtures/fake-claude.mjs` instead; the
production wiring in `src/main/index.ts` only ever builds the Docker one.

## Boundaries and contracts

```
executor.start(launch, { onEvent, onRaw, signal, timeoutMs }) → Session
session.send(text)     one {"type":"user","message":{"role":"user","content":text}} line
session.result()       resolves on the next result event: text, usage, cost, session id
session.close()        ends stdin, waits for exit
session.kill(reason)   launch.kill() (docker kill) and the process tree
```

Every stdout line goes to `onRaw` first, unparsed, for the task's JSONL; the reader
then yields normalized events. Paths in `Read`, `Grep`, `Glob`, `Edit`, `Write`
inputs under `/work/` are rewritten to source-relative paths in a `files` field.

Login and status run the same image with the same config volume through
`docker run --rm -i … claude auth …`, built by the sandbox's argument builder with
no workspace mount.

## Alternatives considered

The loopback hook server and per-run MCP server of
adr:0002-run-the-specialist-through-the-pinned-claude-code-cli are dropped: under
adr:0006-run-the-specialist-inside-a-container-per-task the container's only route
out is the egress proxy, and `--tools` already limits the specialist to file tools
over `/work`. Reopening a path to the host would undo the boundary.
