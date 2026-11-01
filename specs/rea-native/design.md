# Rea native — design

## What changes

Serves R1.1–R3.3, under adr:0018-make-rea-native-to-the-specialist.

- `sandbox/specialist-base/Dockerfile` — a fetch stage downloads each engine from its release and
  checks its SHA-256 (the same pattern as the CLI's verify stage), then the final stage copies them
  to `/opt/jdk-21`, `/opt/ghidra`, `/opt/jadx` and `/opt/apktool`, installs `rea-agents` globally,
  copies the skill directory and `AGENTS.md`, and sets the engines' environment (R1). The untracked
  draft under `sandbox/base/` folds into it and goes. Its context hash changes, so the Images
  workflow publishes it and `npm run pin-images` re-pins it.
- `sandbox/specialist-base/AGENTS.md` (new) — the specialist's operating guide: REA's workflow as
  the specialist follows it, the evidence rules, where the evidence bundle goes. One file, read by
  both the image and the system prompt (R1.2, R2.3).
- `src/main/sandbox/docker.ts` — `mcpConfig` adds the `rea` server; `claudeArgs` allows
  `mcp__rea`; `containerEnv` adds `MCP_TOOL_TIMEOUT`; `dockerRunArgs` binds `/root/out` (R2.1, R2.2,
  R2.4).
- `src/main/sandbox/prompt.ts` — the system prompt includes `AGENTS.md`, imported as text, and the
  pointer to the skill (R2.3).
- `src/shared/context.ts` — `Evidence` gains a `kind` (`lines`, `address`, `rea`) and its address or
  id; `parseEvidence` reads the two new forms; the default report format names all three (R3).
  `DelegationCard` shows each kind.

## Data

`Evidence` keeps `path`, `startLine`, `endLine`, `claim` and `checked`, and adds `kind` and
`ref` — the address (`0x…`) or the REA id. A line range keeps `kind: "lines"` and no `ref`, so
evidence stored before this change still reads as lines.
