# Orchestrator — tasks

## 1 · Model

- [x] 1.1 (Unit) Build `ChatOpenRouter` from settings with the fallback model, `data_collection: "deny"` and a usage callback that records events and task totals — R1.1, R1.2, R1.3
- [x] 1.2 (Unit) Map OpenRouter failures to messages the user can act on — R1.4
- [x] 1.3 (Unit) Send the chosen reasoning effort as `reasoning.effort` through `ChatOpenRouter`'s model arguments — R1.5

## 2 · Delegation

- [x] 2.1 (Unit) Define the context package schema and the `delegate_to_specialist` tool over the sandbox, returning report, evidence and patch, or the reason as a tool error — R2.3, R2.4, R2.5
- [x] 2.2 (Unit) Assemble the agent: system prompt, read-only filesystem backend, `apply_patch` behind `interruptOn`, and `write_todos` recorded as steps — R2.1, R2.2, R3.1
  _Depends 1.1, 2.1_
- [x] 2.3 (Unit) Redact secret shapes from the delegation result returned to the model — R2.6
  _Depends 2.1_
- [x] 2.4 (Unit) Run the agent's file and command tools in a read-only task container through a DeepAgents sandbox backend, removed when the task ends — R2.2
  _Depends 2.2_
- [x] 2.5 (Unit) Ask the agent for a truthful brief per delegation in the tool schema and system prompt — R2.7
  _Depends 2.1_
- [x] 2.6 (Unit) Run the task container as root with a writable root filesystem — R2.8
  _Reason The orchestrator's code could not apt-get the tools it needed_
- [x] 2.7 (Unit) Start a task container that went away again — R2.9
  _Reason A sweep removed a live task's container and every call failed after_

## 3 · Lifecycle

- [x] 3.1 (Unit) Run a task: start, pause for approval, resume with the decision, record the result, cancel, retry — R3.1, R3.2, R3.3, R3.4, R3.5
  _Depends 2.2_
- [x] 3.2 (Unit) Test a whole task end to end against the fake Claude Code CLI and a scripted OpenRouter, asserting the event log and the sandbox audit — R2.4, R3.1, R3.3
  _Depends 3.1_
