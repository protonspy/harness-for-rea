---
autonomy: auto
ci: wait
branch: fix/delegation-idle-timeout
delivery: in-review
pr: 30
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
- **R1.3** (MODIFIED) When a delegation is cancelled or stays inactive for longer than its inactivity timeout, the specialist executor shall stop the CLI and its container and report the delegation as cancelled or timed out.
- **R1.4** If the CLI exits without a result, then the specialist executor shall report the failure with the last line of its error output, classified as auth, limit or failed.
- **R1.5** Where the user chose an effort for the specialist, the specialist executor shall start Claude Code with `--effort` set to it.
- **R1.6** (ADDED) While a turn is in progress and none of its tool calls but a subagent's is open, the specialist executor shall restart a delegation's inactivity clock on every output line that carries a stream event, and shall hold the clock at all other times.
- **R1.7** (ADDED) If a tool call stays open for as long as Claude Code's MCP tool timeout with no other tool call opening or closing, then the specialist executor shall stop the CLI and its container and report the delegation as timed out.
- **R1.8** (ADDED) If the CLI has not exited 30 seconds after its stdin ends, then the specialist executor shall stop the CLI and its container and keep the delegation's outcome.

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
