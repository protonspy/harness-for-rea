---
status: accepted
---

# 0001 · Use DeepAgents on OpenRouter for orchestration

## Context

The orchestrator plans a task, splits it into steps, decides when a step needs the
specialist, and consolidates the results. The user picks its model, and the app must
not be tied to one vendor, so the model is reached through OpenRouter. The
reference project `study-lab` already runs DeepAgents 1.15.1 on `ChatOpenRouter`
from `@langchain/openrouter` in an Electron main process, with tests driven by a
scripted `fetch`. DeepAgents (JS) provides what the orchestrator would otherwise
build by hand: `write_todos` for decomposition, subagents and custom tools for
delegation, pluggable filesystem backends (`FilesystemBackend`, `CompositeBackend`),
`interruptOn` for approve/edit/reject before a tool runs, and a checkpointer for
resuming a run. The user asked for this framework explicitly.

## Decision

The orchestrator is a `createDeepAgent` agent whose model is a `ChatOpenRouter`
instance configured from the user's settings. The Claude specialist is exposed to it
as a custom tool, not as a DeepAgents subagent, because it runs in its own process
with its own tools and context. Rejected: a hand-written tool-calling loop over the
OpenRouter HTTP API, which `study-lab` also has, because it would re-implement
planning, approval interrupts and checkpointing; and LangGraph directly, which is
the layer DeepAgents already composes.

## Consequences

- Orchestration code is shaped around LangChain message and tool types; replacing
  DeepAgents later means rewriting the orchestrator, not swapping a client.
- `study-lab` needed `legacy-peer-deps` to install DeepAgents beside `langsmith`;
  this project inherits that peer-dependency friction until it is resolved upstream.
- Tools run in the Electron main process; heavy work inside a tool must be moved off
  it or the UI stalls.
- OpenRouter receives source code; requests default to `provider.data_collection:
  "deny"`.
- Model pricing and token usage come from OpenRouter's `usage` object rather than a
  local price list.
