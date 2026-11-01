---
status: accepted
---

# 0018 · Make REA native to the specialist

## Context

The specialist does the reverse engineering, and the user wants it to work as a harness of REA
(see the wiki page rea-in-the-sandbox): REA's MCP server attached, its skill, and an operating guide in the role
of an `AGENTS.md`, so that every analysis follows REA's workflow and evidence model.

Today the specialist starts with `--setting-sources ""` and `--strict-mcp-config`, so nothing from
a settings file, a skills folder or an `AGENTS.md` loads. Its only MCP server is the ask-user one
(adr:0008-ask-the-user-from-the-specialist-over-the-run-channel).

REA installs no engines. Native decompilation needs Ghidra and a JDK 21, which Debian bookworm
does not ship, and Android needs JADX and Apktool. The user chose to bake REA, Ghidra and the
Android tools into the image, and to give REA to the specialist only. Reports cite evidence as
`path:lines`, which drops REA's `ev_…` and `unk_…` identifiers and every address in a binary.

## Decision

**The image.** The published base image (adr:0012-pull-the-specialists-base-image-from-ghcr)
carries, each pinned by version and checked against its SHA-256 at build:

- `rea-agents` 6.8.0, with every dependency from a lockfile committed beside the Dockerfile,
  installed with `npm ci` without optional packages or install scripts;
- Ghidra 12.1.4;
- Temurin JDK 21;
- jadx-headless-mcp 0.7.1;
- Apktool 3.0.3.

The image also holds REA's whole skill directory at `/opt/hfr/rea-skill/`, and the specialist's
operating guide, `sandbox/specialist-base/AGENTS.md`, at `/opt/hfr/AGENTS.md`. The engines' paths
are set as image environment variables.

**The specialist.**

- Its MCP configuration adds REA as a stdio server (`rea.mjs mcp`) beside ask-user, and its
  allowed tools add `mcp__rea`.
- Its environment gains an MCP tool timeout long enough for Ghidra's cold start.
- Its system prompt renders the operating guide from the same file the image carries, and
  points to the skill to read first.
- `rea setup` is never run.

**Output.** A delegation's own container binds an output folder of the task's at `/root/out`, as
a sandbox does (adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted).
The specialist exports its evidence bundle there.

**Evidence citations.** A report's evidence lines may cite an REA evidence or unknown id, or an
address in a file, besides a line range.

**The orchestrator.** It is given no REA tool and no REA instructions. Its task container runs
the same image, so the binaries are present there, unused.

**Rejected:**

- Loading the skill through `rea setup` or a skills folder, which `--setting-sources ""`
  ignores. Lifting that flag would let a sample's planted settings load.
- Installing engines per sandbox at run time, which costs minutes for each new sandbox.
- A separate image for the orchestrator, which costs a second published image while its
  instructions already keep it from analysing.

## Consequences

- The base image grows by about 1.2 GB, and its CI build takes longer. A version bump of any
  engine is a re-pinned, tested change, like the Claude Code pin.
- REA's 229-tool catalog is in every specialist session. Claude Code's tool search keeps it out
  of the context on the user's plan; an endpoint that disables tool search would pay for it.
- The specialist can still run tools it installs itself (adr:0016-let-the-orchestrator-run-the-specialists-sandbox);
  REA is the default path, not the only one.
- REA's evidence ledger lives in its server process: what the specialist does not export to
  `/root/out` is gone when the run ends.
- The orchestrator could run `rea` through `execute`; only its instructions stop it. A separate
  image is the next step if it does.
- REA's tools take any path inside the container, so the rule that keeps Claude Code's file tools
  out of the login volume does not bind them; with root `Bash` already able to read it, this
  widens nothing. Several REA tools run code (process capture, Rizin commands), as `Bash` does.
- An REA id in a report is cited, not checked: nothing compares it with the exported bundle.
