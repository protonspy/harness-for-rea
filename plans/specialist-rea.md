---
autonomy: auto
ci: wait
status: approved
checksum: c2f102d9fb85da3ed2832770a4c5822e43e3c8cdfc2bbc6ea3bfe3fee840f172
---

# Specialist rea

The second round of the harness: sandbox images pulled from a registry, a specialist
container that never outlives its run, a chat that runs in English and can approve its
own tool calls, and a specialist built on REA with a sandbox free of all but its files, with the egress proxy gone.

## Why

Testing the first round showed a stale specialist image that the app took as ready, an
Anthropic usage-policy refusal with nothing done about it, prompts mixing the user's
language into the specialist's context, and a specialist without the reverse
engineering tools it needs. Done means the app prepares its images by itself at start,
cleans up every specialist container, handles a refusal once with what the user
states, runs every prompt in English, and lets the specialist analyse with REA and any
tool it installs, reaching only the files it was given.

## Paths

- `sandbox/` — the published base and the local specialist layer
- `.github/workflows/` — the image publishing workflow
- `src/main/sandbox/`, `src/main/status.ts`, `src/main/delegation.ts` — images, containers, delegation
- `src/main/orchestrator/` — prompts, gated tools, the context package
- `src/renderer/src/views/Settings.tsx` — image state, automatic tool calls
- https://github.com/morluto/rea — REA, the reverse engineering MCP server and skill

## References

- `specs/sandbox-images/` — a public base image on GHCR pinned by digest, the verified Claude Code CLI added in a local layer, automatic preparation at start, stale image detection, the egress proxy and its network removed, and both sandboxes given full internet access
- `specs/specialist-lifecycle/` — the specialist container removed whenever Claude Code ends, a usage-policy refusal as its own failure answered by one re-delegation per refused step with the purpose and authorization the user states, the specialist pinned to Opus 5.5
- `specs/chat/` — delta: an option per task to run every gated tool call, `apply_patch` included, without asking; every prompt, brief and context package in English, while the chat answers in the user's language
- `specs/rea-native/` — REA's MCP server, prompt and skill in the specialist, its shell and root inside its container with a writable root filesystem to install any tool — never `--privileged` nor the Docker socket — isolated only by the files it receives, the shared login volume kept with its exposure accepted, under its own ADR
- `specs/task-sandbox/`, `specs/orchestrator/`, `specs/desktop-ui/`, `specs/claude-specialist/` — deltas for the network, the image check, Settings and the model pin, each in the PR of the spec that changes it
- Delivered in order: specs/sandbox-images, specs/specialist-lifecycle, specs/rea-native, then the specs/chat delta
- adr:0012-pull-the-specialists-base-image-from-ghcr
- adr:0013-give-the-sandboxes-full-internet-access
- adr:0002-run-the-specialist-through-the-pinned-claude-code-cli
- adr:0006-run-the-specialist-inside-a-container-per-task

## Out of scope

- Rewording a refused request automatically until the usage-policy check lets it through
- Publishing an image that holds the Claude Code binary
- Images for any platform but linux/amd64
- Restricting either sandbox's internet access
- Distributing the app to other users

## Tasks

- [ ] 1.1 (Unit) Record as ADRs the public base image pulled from GHCR, and both sandboxes — the specialist's and the task container — on Docker's own network with full internet access and the egress proxy removed, and update `docs/stack.md`, `docs/glossary.md` and the Boundaries in `.claude/rules/project.md` to match
- [ ] 1.2 (Unit) Cite the REA ADR from `sandbox/base/Dockerfile`, in place of the colliding adr:0008-make-rea-native-to-the-sandboxes
  _Depends 1.1_

## Done when

- `scc validate --checks --pr` exits 0 with every referenced spec's tasks ticked
- A fresh Docker with no `hfr-*` image gets every image at app start, and a real delegation runs on them
- No `hfr-<id>` specialist container is left after a delegation ends, in success, failure, cancellation or refusal
- Upgrading from the first round removes the `hfr-egress` container, image and `hfr-sandbox` network, and takes the old `hfr-specialist` image as stale
- A real delegation on a sample binary shows the specialist calling REA's tools, with its brief in English
