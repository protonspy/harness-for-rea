---
autonomy: auto
ci: wait
---

# Event log — requirements

## Purpose

One record of everything the agents do — who did what, when, with which inputs,
tools, files, tokens and cost — written once, redacted before it touches disk, shown
live in the UI and kept for history and audit. Decided in
adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task.

## R1 · Schema and redaction

- **R1.1** The event log shall store each event with its task, its step when it has one, its agent, time, kind, state, a one-line summary, and a payload holding inputs, outputs, tools, files, errors, tokens and cost.
- **R1.2** The event log shall redact API keys, bearer and OAuth tokens, private keys and the stored OpenRouter key from every event and every raw line before writing either store.
- **R1.3** If an event's payload exceeds the size cap, then the event log shall truncate it and mark it truncated.

## R2 · Storage and delivery

- **R2.1** The event log shall keep tasks, steps and events in SQLite, migrated by `user_version`.
- **R2.2** The event log shall append each agent's raw output lines, unparsed, to the task's own JSONL file.
- **R2.3** When an event is written, the event log shall push it to the renderer.
- **R2.4** When the renderer asks for a task's history, the event log shall return the task, its steps and its events in order, paged.

## R3 · Recovery

- **R3.1** When the app starts, the event log shall mark every task and step left running or waiting as interrupted and record an event saying so.

## Out of scope

- Exporting or deleting history from the UI.
