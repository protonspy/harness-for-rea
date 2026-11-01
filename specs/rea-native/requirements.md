---
autonomy: auto
ci: wait
branch: feat/rea-native
delivery: in-progress
---

# Rea native — requirements

## Purpose

The specialist works as a harness of REA, the reverse engineering MCP server: REA, Ghidra and the
Android tools ready in its image, REA attached to every run, and an operating guide that holds each
analysis to REA's workflow and evidence model, so its reports cite what REA recorded
(adr:0018-make-rea-native-to-the-specialist).

## R1 · The image

- **R1.1** The specialist's base image shall carry `rea-agents`, Ghidra, a JDK 21, jadx-headless-mcp and Apktool, each at a pinned version whose SHA-256 the build checks before installing it.
- **R1.2** The specialist's base image shall carry REA's whole `reverse-engineer-anything` skill directory at `/opt/hfr/rea-skill/` and the operating guide at `/opt/hfr/AGENTS.md`.
- **R1.3** The specialist's base image shall set `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `REA_JADX_MCP_JAR` and `REA_APKTOOL_COMMAND` to the engines it carries.

## R2 · The specialist's run

- **R2.1** The delegation shall start Claude Code with REA's MCP server over stdio beside the ask-user server, and allow every REA tool.
- **R2.2** The delegation shall give Claude Code an MCP tool timeout of at least ten minutes.
- **R2.3** The specialist's system prompt shall contain the operating guide from `sandbox/specialist-base/AGENTS.md` and direct the specialist to read the skill at `/opt/hfr/rea-skill/SKILL.md` before its first REA call.
- **R2.4** Where a delegation names no sandbox, the delegation shall bind the task's `outputs/<workspace>` folder writable at `/root/out`.

## R3 · Evidence

- **R3.1** The report format shall accept an evidence line citing a line range, an REA evidence or unknown id (`ev_` or `unk_` and 64 hex digits), or an address in a file (`<path>@0x<hex>`).
- **R3.2** When a report cites an address in a file, the delegation shall record its path and address, and mark it checked when the path is one of the delegation's files.
- **R3.3** When a report cites an REA id, the delegation shall record the id as cited.

## Out of scope

- Giving the orchestrator REA's tools or instructions.
- Hopper, JEB, IDA, Frida and the macOS and ADB tools, which need a licence, a GUI, a host or a device.
- A machine-readable contract, an unknowns ledger the app keeps, and replaying test vectors (ideas from the wiki page craft-anything, for a later spec).
