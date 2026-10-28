# Orchestrator — tasks

## 1 · Model

- [x] 1.1 (Unit) Build `ChatOpenRouter` from settings with the fallback model, `data_collection: "deny"` and a usage callback that records events and task totals — R1.1, R1.2, R1.3
- [x] 1.2 (Unit) Map OpenRouter failures to messages the user can act on — R1.4

## 2 · Delegation

- [x] 2.1 (Unit) Define the context package schema and the `delegate_to_specialist` tool over the sandbox, returning report, evidence and patch, or the reason as a tool error — R2.3, R2.4, R2.5
- [x] 2.2 (Unit) Assemble the agent: system prompt, read-only filesystem backend, `apply_patch` behind `interruptOn`, and `write_todos` recorded as steps — R2.1, R2.2, R3.1
  _Depends 1.1, 2.1_
- [x] 2.3 (Unit) Redact secret shapes from the delegation result returned to the model — R2.6
  _Depends 2.1_

## 3 · Lifecycle

- [x] 3.1 (Unit) Run a task: start, pause for approval, resume with the decision, record the result, cancel, retry — R3.1, R3.2, R3.3, R3.4, R3.5
  _Depends 2.2_
- [x] 3.2 (Unit) Test a whole task end to end against the fake Claude Code CLI and a scripted OpenRouter, asserting the event log and the sandbox audit — R2.4, R3.1, R3.3
  _Depends 3.1_
