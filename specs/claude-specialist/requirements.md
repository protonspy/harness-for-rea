---
autonomy: auto
ci: wait
branch: feat/harness-for-rea
delivery: in-progress
---

# Claude specialist — requirements

## Purpose

The specialist is Claude Opus running the pinned Claude Code CLI inside the
delegation's sandbox container (`specs/task-sandbox/`), signed in with the user's
own Claude plan. This feature starts it, talks to it over stream-json, reads what it
does into events with usage and cost, and stops it. Decided in
adr:0002-run-the-specialist-through-the-pinned-claude-code-cli,
adr:0003-authenticate-the-specialist-with-the-users-claude-plan and
adr:0006-run-the-specialist-inside-a-container-per-task.

## R1 · Process

- **R1.1** The specialist executor shall start the Claude Code CLI only through a run prepared by the sandbox, never as a process on the host.
- **R1.2** The specialist executor shall send each user turn as a stream-json message on stdin and keep stdin open until the delegation ends, so a delegation can carry more than one turn.
- **R1.3** When a delegation is cancelled or exceeds its timeout, the specialist executor shall stop the CLI and its container and report the delegation as cancelled or timed out.
- **R1.4** If the CLI exits without a result, then the specialist executor shall report the failure with the last line of its error output, classified as auth, limit or failed.

## R2 · Stream

- **R2.1** The specialist executor shall turn each stream-json line into events for assistant text, thinking, tool calls with their arguments, tool results and the final result, attributing calls made inside a subagent to that subagent.
- **R2.2** When the result arrives, the specialist executor shall record its input, output and cache tokens, `total_cost_usd` as an estimate, its duration and its session id.
- **R2.3** If a line is not JSON or has a type the reader does not know, then the specialist executor shall keep the raw line and record an event for it rather than drop it.
- **R2.4** The specialist executor shall cap the size of the text, arguments and results it records, marking a capped field as truncated.
- **R2.5** The specialist executor shall report each file a tool call reads or writes by its path relative to the source root, mapped back from `/work/<path>`.

## R3 · Login

- **R3.1** When the user signs in, the specialist executor shall run `claude auth login --claudeai` in the sandbox image on the sandbox's config volume, expose only an Anthropic https URL it prints, and pass on the code the user pastes.
- **R3.2** The specialist executor shall report the login state from `claude auth status --json` without reading the stored credential.

## Out of scope

- Anthropic API key, Bedrock, Vertex or Foundry authentication.
- MCP servers or hooks reaching back from the container to the host.
