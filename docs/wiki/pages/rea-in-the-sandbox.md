# REA in the specialist's sandbox

## What REA is

REA ("Reverse Engineer Anything", [morluto/rea](https://github.com/morluto/rea), `rea-agents` on npm,
MIT) is a local reverse engineering CLI and MCP server. Version 6.8.0 has one catalog of 229 tools
covering:

- native binaries;
- .NET assemblies;
- JavaScript and Electron applications;
- archives and packages;
- Android APKs;
- firmware;
- captures and browsers.

Every result is an immutable Evidence record. The skill `reverse-engineer-anything` is the workflow
that tells an agent how to use them. REA's own `AGENTS.md` is a contributor guide, not agent
instructions: the skill and the server's MCP prompts are the only agent guidance it ships.

## How it runs headless in the container

**Install.** REA is installed globally at a pinned version: `npm install -g rea-agents@<v>`, on
Node `^24.22.1`, with no install scripts. The 6.8.0 tarball carries no shrinkwrap: direct
dependencies are exact, transitive ones float.

**Connection.** The specialist reaches it through `--mcp-config` as a stdio server: `node <npm
root>/rea-agents/scripts/rea.mjs mcp`. Its tools appear as `mcp__rea__<tool>`.

**Never `rea setup`.** It writes a client registration and a personal skill copy, and the specialist
loads neither, because it starts with `--setting-sources ""` and `--strict-mcp-config`. The skill
therefore reaches the specialist through its system prompt. The whole skill directory has to be in
the image, its `references/` included, so the specialist can read them. The server also serves the
skill at run time (`search_guidance`, `read_guidance_section`) and six guided workflows as MCP
prompts.

**What works.** REA installs no engines. On Linux it needs a procps `ps` for every child it
supervises. What works headless follows from what the image supplies:

- **Built in:** JavaScript, Electron and ASAR; archive inventory; PE, ELF and Mach-O inspectors;
  Go, Rust, pyc, BEAM, EVM, IL2CPP metadata, SQLite; .NET metadata and CIL.
- **With a supplied tool:**
  - Ghidra 12.1 with JDK 21 (`GHIDRA_INSTALL_DIR`, `JAVA_HOME`); Debian bookworm ships only JDK 17;
  - JADX (`REA_JADX_MCP_JAR`), Apktool (`REA_APKTOOL_COMMAND`);
  - WABT, Binwalk and Unblob, tshark, objdump, GDB, Rizin;
  - Chromium for browser capture.
- **Unavailable:**
  - Hopper, JEB and IDA, which are commercial or licence-bound;
  - Apple native UI and LLDB tools, which need macOS;
  - ADB tools, which need a device;
  - Frida, whose optional binding is not installed.

`binary_session {}` is the authority on what a server can do; its `tool_availability` says why each
unavailable operation is unavailable.

**Cost and timeouts.** The catalog is large. `REA_MCP_INPUT_SCHEMA_PROFILE=compact` (the default)
and a `REA_MCP_TOOL_FAMILIES` subset keep it from crowding the context, which matters when the
model endpoint turns tool search off. Ghidra's cold start can take 330 s, so the client's tool
timeout has to allow it.

**State.** State lives under `~/.rea`, which the XDG variables do not move.

## Workflow and evidence model

**Routing and sessions.** Route the target first: the input decides the first tool. An ASAR goes to
`analyze_javascript_application`, an APK to `inspect_android_package`, a .NET assembly to
`inspect_managed_artifact`, firmware to `inspect_firmware_regions`, a native file to `open_binary`.
`open_binary` binds one active target per server until `close_binary`.

**Summary first.** Ask for `detail: "summary"`, then page the retained record with
`inspect_analysis_view` and its `parent_evidence_id`. Never repeat an identical analysis.

**Evidence records.** Every record carries an `evidence_id` of the form `ev_<64 hex>`, a SHA-256 of
its canonical content. With it come:

- the subject's SHA-256;
- the provider;
- an authority: `shipped-artifact`, `controlled-replay`, `historical-reference`,
  `external-service` or `analyst-inference`;
- a confidence: `observed`, `derived` or `inferred`;
- its limitations and coverage.

Static evidence never establishes execution.

**Unknowns.** An open question is a residual unknown, `unk_<64 hex>`:

- `record_unknown` creates it with its supporting and contradicting evidence.
- `update_unknown` revises it against its current revision; on a conflict, read it again rather
  than retrying.
- `verify_unknown_resolution` confirms that a `verified` resolution is backed by qualifying
  evidence.

**Keeping an investigation.** The evidence ledger lives in the server process's memory, so
`export_evidence_bundle` is the only way an investigation outlives the specialist.
`import_evidence_bundle` brings one back.

**Reconstruction.** `build_reconstruction_obligation_ledger` turns a bundle into obligations. Each
closes only with a unique owner, fixtures and a passing verifier of comparable authority. A pass of
`verify_reconstruction` covers only the claims it declares.

## What the specialist's operating guide says

- REA is already connected and its tools are fixed. Never run `rea setup`, `rea update` or `npx
  rea-agents`, and never ask for a client restart. The skill's "connect only when needed" section
  does not apply.
- Call `binary_session {}` once, then route the target and work summary-first.
- Turn the objective into a checklist of questions. Keep a finding ledger: each conclusion with its
  Evidence IDs, authority and confidence, and what remains unknown.
- Record every unresolved question with `record_unknown`. Before calling one resolved, run
  `verify_unknown_resolution`.
- Label each claim as observation, inference or unknown, and cite `ev_…` and `unk_…` IDs verbatim.
- Before finishing:
  - export the evidence bundle to the output folder;
  - close the target;
  - mark each checklist question answered, partial or unresolved.

Related: [[craft-anything]], whose unknowns ledger and sourced-constant check rest on the same idea.
