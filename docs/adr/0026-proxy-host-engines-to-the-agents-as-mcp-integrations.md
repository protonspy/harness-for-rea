---
status: accepted
---

# 0026 · Proxy host engines to the agents as MCP integrations

## Context

The user wants the agents to use engines that only run on the Windows host: Cheat Engine now, to
analyse the live memory of Windows software, and IDA Pro's MCP later. Cheat Engine's MCP is to be
built on `miscusi-peek/cheatengine-mcp-bridge` (MIT). The user wants the integrations as a list
in Settings, and to choose tool by tool which go to the orchestrator and which to the specialist:
by default the specialist gets every tool and the orchestrator only what lets it discover what is
there before it delegates.

The specialist runs in a Linux container per delegation
(adr:0006-run-the-specialist-inside-a-container-per-task) with REA as its analysis server
(adr:0018-make-rea-native-to-the-specialist); the orchestrator plans and delegates
(adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code). The upstream bridge is
a Lua script inside Cheat Engine answering JSON-RPC on a named pipe, a Python MCP server on the
host and an optional TCP relay for a server in a container. Its Lua answers about 180 commands —
memory writes, DLL injection, code execution, a kernel driver, shell and file commands — to any
client of the pipe; the gate on the shell commands is in the Python server only. A container
reaches a service bound to the host's `127.0.0.1` through `host.docker.internal`, checked on this
host's Docker Desktop, and the sandboxes have full internet access
(adr:0013-give-the-sandboxes-full-internet-access), so a relay would hand Cheat Engine to every
process in every container, a sample's code included. What a target's memory or database holds is
the target's data, and text in it reaches the model.

## Decision

The app carries a list of integrations in its own code, each with its settings, its checks, its
catalog of tools, the orchestrator's default for each tool and, when its tools work on one, its
kind of target; Settings offers no way to add another server. The app is the only path to an
engine. The specialist gets one MCP server per integration, offering the tools checked for it,
whose calls travel as files over the existing ask channel
(adr:0008-ask-the-user-from-the-specialist-over-the-run-channel) to the app; the orchestrator gets
the tools checked for it as its own tools, under the same names. The app checks every call
against the catalog, the agent's checkboxes and the task's approved target before it forwards it.
A target — Cheat Engine's is a process by PID — is approved by the user every time, in an
automatic task too, with no approval by default. No mount, port or environment variable is added
to the container. For Cheat Engine the app ships its own bridge, derived from upstream commit
`6bd7ce90`, on its own pipe, with only the handlers of commands that read. Rejected: the upstream
TCP relay, which needs no credential and is reachable from every container; the upstream Python
server, which adds Python to the host and leaves its Lua answering every command; MCP servers the
user adds, whose tools the app could not gate by kind; a mount of its own for the calls, which
widens the boundary when the ask channel already crosses it; and the container's servers in the
base image, which would need a GHCR publish and a re-pin
(adr:0012-pull-the-specialists-base-image-from-ghcr) for every catalog change.

## Consequences

- This extends adr:0011's allowlist with the tools the user checks for the orchestrator. Its
  defaults keep the rule that analysis goes to the specialist; a user who checks a tool that reads
  a target gives the orchestrator's model — a cheap one, on a provider of the user's choice — the
  target's data and any injection in it, with a warning and nothing more.
- The specialist can read anything the approved target exposes, secrets included, and what it
  reads goes to its model and its report. The approval is the only check on which target that is.
- Anything in the container can write a call file, so a sample's code can use the specialist's
  tools on the approved target; it cannot name another target or a tool off the catalog.
- The system prompt names an integration's answers as data, which is policy, not a boundary.
- Cheat Engine's bridge is a fork of a 6,000-line Lua file: upstream fixes come in by hand, and a
  test that holds its handlers equal to the catalog is what stops a write command slipping back.
- An engine runs with the user's rights on the host and answers only while it is open with its
  plugin loaded; nothing in the app sandboxes the engine itself.
- Writes, injection, breakpoints and debugging stay out of Cheat Engine's catalog; adding any of
  them is a new decision.
- Containers can still reach other services on the host's loopback; that is a separate decision
  this record does not take.
