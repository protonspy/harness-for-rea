---
status: accepted
---

# 0027 · Ship a read-only IDA plugin on a named pipe

## Context

IDA Pro is the second MCP integration that adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations
anticipated, and the user wants it built on `mrexodia/ida-pro-mcp` (MIT). Upstream has two
servers. Its IDA plugin serves every tool — renames, comments, types, patching, the debugger and
`py_eval`, which runs arbitrary Python inside IDA with the user's rights — over HTTP on
`127.0.0.1:13337` with no credential; its `idalib-mcp` runs IDA headless and serves the same tools
over HTTP on another loopback port, plus `idb_open`, which opens any file on the host. A container
reaches the host's loopback through `host.docker.internal`, and the sandboxes have full internet
access (adr:0013-give-the-sandboxes-full-internet-access), so either server would hand IDA to every
process in every container, a sample's code included — the reason adr:0026 rejected Cheat Engine's
TCP relay. Upstream also ships `profiles/readonly.txt`, the 34 tools that never change the
database. Upstream now recommends Hex-Rays' own MCP server; the user chose this one.

## Decision

The app ships its own IDA plugin, derived from upstream commit `c133c38`, installed in IDA's user
`plugins` folder. It keeps upstream's tool code for the read-only profile only, every other tool
deleted rather than disabled, and replaces upstream's HTTP server with a named pipe of its own,
`\\.\pipe\hfr-ida`, that refuses remote clients and speaks the framing of Cheat Engine's bridge.
The integration's target is the database open in IDA, named by the SHA-256 of its input file and
approved by the user under adr:0026. The user opens the database in IDA; the app never does.
Rejected: upstream's plugin as it is, for the open loopback port and its unsafe tools; `idalib-mcp`,
for the same port, `idb_open`, and the Python and `idalib` setup it needs beside IDA; the
annotation tools, which write into the user's database — a separate decision if they are wanted;
and upstream's trace, which records every call into the database.

## Consequences

- The plugin is a fork of about 9,000 lines of Python: upstream fixes come in by hand, and a test
  that holds its `@tool` functions equal to the catalog is what stops a write tool slipping back.
- The agents read whatever the approved database holds, and its strings and names reach the models;
  the system prompt names the answers as data, which is policy, not a boundary.
- The pipe takes any local client of the user, as Cheat Engine's does (n-0014, n-0015); the gate binds
  the agents, not other local processes.
- Decompiling can update the decompiler's caches in the database, as it does when the user does it
  by hand; nothing else a tool does writes.
- A second IDA cannot open the pipe while the first holds it, so the agents see one database at a
  time: the first one opened.
