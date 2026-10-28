---
autonomy: auto
ci: wait
pr: per-plan
merge: manual
---

# harness-for-rea

A desktop app where an orchestrator model on OpenRouter decomposes a software
engineering task and delegates deep analysis to a Claude Opus specialist running
in Claude Code, each delegation in its own read-only sandbox, with every event
logged and visible in real time.

## Why

Legacy-system comprehension, debugging and authorized reverse engineering need
deep reasoning on narrow, well-scoped evidence, while planning and consolidation
can run on any model the user picks. The app makes that split explicit, keeps the
specialist away from everything outside its task, and leaves an audit trail of who
read and changed what. Done means a user can describe a task, watch it decompose
and delegate, inspect the evidence, and approve or reject any proposed change.

## Paths

- `src/main/` — orchestrator, specialist, sandbox, events, credentials
- `src/preload/`, `src/shared/` — typed, validated IPC contract
- `src/renderer/` — React UI
- `tests/` — fake Claude Code CLI and scripted OpenRouter harness
- `C:\Users\prode\study-lab` — reference: app skeleton, `src/main/claude/*`, `src/main/harness/{model,agent,claude}.ts` (DeepAgents on ChatOpenRouter), `openrouter.ts`, `db.ts`, IPC
- `C:\Users\prode\MagnoTech\projeto-1-engenharia-autocad-csharp\desktop\electron` — reference: `turno.ts`, `leitorDoStream.ts`, `servidorDeRegras.ts`

## References

- `specs/app-shell/` — Electron skeleton, hardened window, validated IPC, safeStorage credential store with no plaintext fallback, delivery-gate commands
- `specs/event-log/` — unified event schema, secret redaction, SQLite index plus per-task raw JSONL, incremental push to the UI, crash recovery
- `specs/claude-specialist/` — executor for the pinned Claude Code CLI run in the sandbox container, subscription login on the sandbox config volume, stream-json parser with usage and cost, multi-turn stdin, kill and timeout
- `specs/orchestrator/` — DeepAgents (`createDeepAgent`) on `ChatOpenRouter` with a user-chosen model defaulting to `deepseek/deepseek-v4.1-flash-1017` with `z-ai/glm-5.3-flash` as preset and fallback, `write_todos` decomposition, the specialist as a delegation tool fed a context package, `interruptOn` approval of writes, checkpointer for resume, consolidation, cancellation and recovery
- `specs/task-sandbox/` — one container per delegation with `workspace/<uuid>/` mounted at `/work`, prompt rendered only from the context package, egress proxy, audit of files touched, patch approval, discard ([adr:0006-run-the-specialist-inside-a-container-per-task])
- https://reference.langchain.com/javascript/deepagents — orchestration framework
- https://docs.langchain.com/oss/javascript/integrations/chat/openrouter — `ChatOpenRouter` from `@langchain/openrouter`: tool binding, streaming, `models` fallback routing, `provider.data_collection: "deny"` by default since source code is sent
- `specs/desktop-ui/` — settings, tasks and agents view, live logs, evidence and files, history, permissions, token and cost

## Out of scope

- Distributing the app to other users: the specialist authenticates with the user's own Claude plan login only, which is personal use
- Anthropic API key, Bedrock or Vertex authentication for the specialist
- OS-level isolation on the host: command execution, when enabled, runs only inside a container
- Analysis of software the user does not own or is not authorized to inspect

## Tasks

- [x] 1.1 (Unit) Write ADRs for DeepAgents on OpenRouter as the orchestration framework, the pinned Claude Code CLI over the Agent SDK for the specialist, subscription-login-only auth, the copy-in read-only sandbox with patch-gated writes, and SQLite plus JSONL event storage
- [x] 1.2 (Unit) Record the adopted stack in `docs/stack.md` and the canonical terms (orchestrator, specialist, delegation, context package, sandbox, evidence) in `docs/glossary.md`
- [x] 1.3 (Unit) Fill `.claude/rules/project.md` and record build, format, lint and test with `scc check set`
  _Depends 1.1, 1.2_
- [x] 2.1 (Unit) Record the orchestrator task container and the orchestrator-written
      brief as ADR 0007 and as deltas to specs/orchestrator and specs/task-sandbox
  _Reason The user asked mid-run for every agent tool to run in a sandbox and for the orchestrator to write the specialist's prompt_
- [x] 2.2 (Unit) Run the orchestrator's file and command tools in a per-task container
      with the source folder bind-mounted read-only, through a DeepAgents sandbox
      backend
  _Reason Same request: DeepAgents sees the whole workspace through a local bind, inside a sandbox_
- [x] 2.3 (Unit) Add the orchestrator-written brief to the context package, scrubbed of
      host paths, and render it first in the specialist's prompt
  _Reason Same request: the orchestrator writes the prompt and narrative handed to Claude Code with the prepared workspace_

## Done when

- `scc validate --checks --pr` exits 0 with every referenced spec's tasks ticked
- The end-to-end test runs a task through orchestrator, delegation, sandbox and consolidation against the fake Claude Code CLI and a scripted OpenRouter, and asserts the event log and the sandbox audit
- A real run on a sample repository shows the decomposition, the specialist's evidence and a proposed patch that is applied only after approval
