---
status: accepted
---

# 0012 · Pull the specialist's base image from GHCR

## Context

adr:0006-run-the-specialist-inside-a-container-per-task builds the specialist image on
the user's machine from a Dockerfile in this repository, and the app treats the image
as ready when its tag and its `hfr.claude-code` label match the pinned Claude Code
version. The image's contents changed in specs/chat (the ask-user MCP server) while the
version stayed the same, and an image built before that change passed the check and
failed at the first question. The user asked for the app to check Docker and pull the
image at start instead of building it. The image holds the Claude Code binary, whose
licence grants no right to redistribute it, and this repository is public.

## Decision

Everything in the specialist's image except Claude Code — the Node base, the tools,
the non-root `agent` user, the ask-user MCP server — is a base image built by this
repository's CI and published to `ghcr.io/protonspy/hfr-specialist-base`, tagged by
the hash of its build context. The repository pins it by registry digest beside that
hash, and the test suite fails when the build context and the pin disagree. On the
user's machine the app pulls the pinned base and builds a short local layer that adds
only the Claude Code CLI, verified against its signed release manifest as
adr:0002-run-the-specialist-through-the-pinned-claude-code-cli requires, and labels
it with the Claude Code version and the base's digest reference. An image is ready
only when both labels match the app's pins. The app prepares a missing or stale
image at start, without being asked. Rejected: publishing the whole image with the
CLI, publicly (redistributes the binary) or privately (needs a registry login on
every machine); and keeping the full local build with a recipe hash label, which
leaves every install to build the whole image.

## Consequences

- A change to the base's build context is published by CI and then re-pinned in the
  repository; a pin the context has moved past fails the tests rather than shipping.
- The package on GHCR must be public for an anonymous pull.
- Preparing the image needs the network on the user's machine: to GHCR for the base,
  and to Anthropic's release host for the CLI.
- The image is linux/amd64 only.
