---
autonomy: auto
ci: wait
branch: feat/ida-pro-mcp
delivery: in-review
pr: 29
---

# Ida pro — requirements

## Purpose

IDA Pro is the second MCP integration (specs/mcp-integrations/): the agents read the database the
user has open in IDA Pro on the host — decompilation, disassembly, cross-references, types, strings
and bytes — through IDA, approved by the user. The app ships its own IDA plugin, derived from
`mrexodia/ida-pro-mcp`, that answers read-only tools only, on a named pipe
(adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe).

## R1 · Settings and checks

- **R1.1** The IDA Pro integration shall hold IDA's user folder as its setting, defaulting to `%APPDATA%\Hex-Rays\IDA Pro` when the setting is empty.
- **R1.2** The IDA Pro integration shall check that the plugin installed in the user folder's `plugins` folder is the one the app carries, and that the plugin answers a ping with the version the app carries.
- **R1.3** When the user asks to install the plugin, the IDA Pro integration shall copy the plugin the app carries into the user folder's `plugins` folder.
- **R1.4** If the plugin cannot be written into the `plugins` folder, then the IDA Pro integration shall show the plugin's path and the folder to copy it into.

## R2 · The plugin and its tools

- **R2.1** The plugin shall answer only the tools of upstream's read-only profile: listings and queries of functions, globals, imports, strings and entities, decompilation, disassembly, cross-references, call graphs, basic blocks, byte and value searches, types and structures, stack frames, reads of the database's bytes, integers, strings and globals, and number conversion.
- **R2.2** If the plugin receives any other method, then the plugin shall answer with a JSON-RPC method-not-found error and run nothing.
- **R2.3** The plugin shall carry the upstream MIT licence notice and the upstream commit it derives from.
- **R2.4** The IDA Pro integration shall offer a `status` tool that returns whether the plugin is connected, the IDA, Python and plugin versions, the open database's input file name, database file name and SHA-256, and the names of the integration's tools, and reads nothing else from the database.
- **R2.5** The IDA Pro integration shall default `status` to the orchestrator, and no other tool.
- **R2.6** The plugin shall accept connections from local processes only.

## R3 · The database

- **R3.1** The IDA Pro integration's target shall be one database, given by the SHA-256 of its input file and shown to the user by the input file's name, the database's path and the SHA-256.
- **R3.2** The `status` and `int_convert` tools shall need no target.
- **R3.3** While a target is approved, the IDA Pro integration shall refuse a call while the database open in IDA is another.
- **R3.4** If IDA has no database open or is closed, then the IDA Pro integration shall answer a call with an error saying the plugin is not answering.

## Out of scope

- Renaming, commenting, setting types, declaring, patching, defining or undefining code and data, and saving the database.
- The debugger, Python evaluation, signature making and anything upstream marks unsafe.
- Upstream's HTTP server, its `idalib` headless server, its output download links and its tool-call trace written into the database.
- Opening a database from the app; the user opens it in IDA.
- IDA Pro on macOS or Linux.
