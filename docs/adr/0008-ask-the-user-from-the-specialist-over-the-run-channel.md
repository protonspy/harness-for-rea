---
status: accepted
---

# 0008 · Ask the user from the specialist over the run channel

## Context

The chat lets either agent ask the user a question mid-run (specs/chat R5). The
orchestrator runs in the Electron main process, so its `ask_user` tool just holds a
promise the UI resolves. The specialist does not: it runs the Claude Code CLI inside a
per-delegation container with every capability dropped and no network but the egress
proxy to Claude's own hosts (adr:0006-run-the-specialist-inside-a-container-per-task).
For it to ask the user, an answer has to cross that boundary and come back, without
opening a second way out of a container built to have none. The run's rendered system
prompt is already bind-mounted into the container, read-only, outside `/work`, so a
host⇄container channel in that same run directory needs no new network and no new
privilege — only a writable file beside an existing mount. The reference project's PoC
used exactly this, a file-based channel polled on both sides.

## Decision

The specialist asks the user through a small MCP server baked into the specialist
image and registered on the CLI's `claudeArgs`. Its one tool writes the question as a
file in the run directory — mounted writable for this purpose, still outside `/work`
and separate from the read-only source — and blocks polling for an answer file. The
host watches the run directory, surfaces the question in the chat, writes the user's
answer (or the default on timeout) to the answer file, and the tool returns it with
its origin. No network path is opened: the channel is the shared directory, nothing
else. Rejected: a local socket or an HTTP endpoint, which is a second listener to
confine inside a container whose whole point is to have no network; and widening the
egress allowlist, which would route a question through Claude's hosts and conflate it
with the specialist's own traffic.

## Consequences

- The specialist image now carries the MCP server; it moves with the pinned CLI
  version (adr:0002-run-the-specialist-through-the-pinned-claude-code-cli), and the
  `claudeArgs` and the run-directory mount in `src/main/sandbox/docker.ts` change as a
  tested change to the sandbox boundary.
- The run directory becomes a two-way channel, not only an input; its contents are
  redacted and bounded like any other agent output before reaching the UI.
- A delegation can block on the user. The approval and question timeouts (specs/chat
  R4.5, R5.4) bound that wait; the task's cancel still aborts the container.
- The specialist can ask for input that steers its analysis, so the same prohibition
  the orchestrator's brief carries — no invented authorization or purpose — is stated
  to the specialist too.
