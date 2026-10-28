---
status: accepted
---

# 0002 · Run the specialist through the pinned Claude Code CLI

## Context

The specialist is Claude Opus running the Claude Code agent loop. Two integrations
exist: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, which offers
`canUseTool`, `permissionMode` and `cwd` per session), and spawning the `claude` CLI
headless with `--output-format stream-json`. Both reference projects already use the
second, tested: `study-lab` (`src/main/claude/*`, CLI 2.1.310) and the MagnoTech
desktop app (`desktop/electron/turno.ts`, `leitorDoStream.ts`, CLI 2.1.309). Both
download a version pinned by SHA-256, check the Authenticode or codesign signature,
isolate `CLAUDE_CONFIG_DIR`, allowlist the environment, force `--setting-sources ""`
and `--strict-mcp-config`, refuse flags that reopen tools, and kill the process tree
with `taskkill /T` on Windows. Each has a fake CLI used by its tests.

## Decision

Port the pinned-CLI executor from `study-lab`, adding from MagnoTech the subagent
attribution and size caps of `leitorDoStream.ts`, multi-turn stdin, and the
loopback hook server. Rejected: the Agent SDK, because adopting it discards two
tested implementations and their fake-CLI harnesses, and its permission callback is
replaceable by `PreToolUse` hooks to the loopback server.

## Consequences

- The app depends on CLI flags and the stream-json event shape of one pinned
  version; upgrading the pin is a deliberate, tested change.
- Unknown event types must be logged and the raw stream kept, or a schema change
  fails silently.
- Each install downloads a binary of roughly 300 MB; Linux is unsupported because
  the pin and signature checks cover only Windows and macOS.
- The native `.exe` is spawned without a shell; an npm `claude.cmd` shim is never
  used.
