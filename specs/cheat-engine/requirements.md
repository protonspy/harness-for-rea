---
autonomy: gated
ci: wait
branch: feat/cheat-engine-mcp
delivery: merged
pr: 20
---

# Cheat engine — requirements

## Purpose

Cheat Engine is the first MCP integration (specs/mcp-integrations/): the agents read the live
memory of a Windows process the user approved, through Cheat Engine on the host. The app ships its
own bridge, derived from `miscusi-peek/cheatengine-mcp-bridge`, that answers read-only commands
only (adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations).

## R1 · Settings and checks

- **R1.1** The Cheat Engine integration shall hold the path to the Cheat Engine executable as its setting.
- **R1.2** The Cheat Engine integration shall check that the executable exists, that the bridge script is installed in Cheat Engine's `autorun` folder, and that the bridge answers a ping with the version the app carries.
- **R1.3** When the user asks to install the bridge, the Cheat Engine integration shall copy the bridge script the app carries into Cheat Engine's `autorun` folder.
- **R1.4** If the bridge script cannot be written into the `autorun` folder, then the Cheat Engine integration shall show the script's path and the folder to copy it into.

## R2 · The bridge and its tools

- **R2.1** The bridge shall answer only commands that read: the process list, modules, memory regions, memory, value and byte-pattern scans, pointer chains, disassembly, symbols and structures.
- **R2.2** If the bridge receives any other method, then the bridge shall answer with a JSON-RPC method-not-found error and run nothing.
- **R2.3** The bridge shall carry the upstream MIT licence notice and the upstream commit it derives from.
- **R2.4** The Cheat Engine integration shall offer a `status` tool that returns whether the bridge is connected, the Cheat Engine and bridge versions, and the names of the integration's tools, and reads no process memory.
- **R2.5** The Cheat Engine integration shall default `status` and `get_process_list` to the orchestrator, and no other tool.

## R3 · The process

- **R3.1** The Cheat Engine integration's target shall be one process, given by PID and shown to the user by its name, PID and executable path.
- **R3.2** The `status` and `get_process_list` tools shall need no target.
- **R3.3** While a target is approved, the Cheat Engine integration shall open only that process in Cheat Engine and refuse a call while the bridge's opened process is another.
- **R3.4** If the approved process exits, then the Cheat Engine integration shall answer every later call on it with an error saying it exited.

## Out of scope

- Writing memory, injecting code or DLLs, executing code, breakpoints and debugging, pausing a process, DBVM and the kernel driver, shell and file commands, input, clipboard and windows.
- The upstream TCP relay, and any network path from a container to Cheat Engine.
- Cheat Engine on macOS or Linux.
