---
status: accepted
---

# 0005 · Store events in SQLite with raw JSONL per task

## Context

Every agent action becomes an event: task, agent, time, state, inputs and outputs,
tools, files, errors, usage and cost. The UI shows them live and in history, and they
serve audit and diagnosis. `study-lab` keeps jobs in memory only, so a crash loses
them, and stores data in `node:sqlite` with `user_version` migrations. The MagnoTech
app keeps append-only JSONL per project but makes the UI re-read every file on each
change, which is O(n) per event, and does not keep the raw CLI stream.

## Decision

Tasks, steps and normalized events live in SQLite (`node:sqlite`, `user_version`
migrations, as in `study-lab`). Each task also appends the raw stream of every agent,
unparsed, to its own JSONL file. Secrets are redacted before either write. The UI
receives each new event as an incremental IPC message and queries SQLite for history.
On start, tasks left running are marked interrupted. Rejected: JSONL only, which
cannot answer history and cost queries without a full scan; and SQLite only, which
loses the raw evidence needed when the parser misreads an event.

## Consequences

- Two stores to keep consistent; the JSONL is the source when they disagree about a
  raw event, SQLite for everything derived.
- `node:sqlite` is still experimental and tied to the Node bundled with Electron.
- Redaction must run before the write; a secret that reaches disk stays in the
  audit trail.
