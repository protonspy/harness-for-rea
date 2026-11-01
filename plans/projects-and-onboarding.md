---
autonomy: auto
ci: wait
status: approved
checksum: 0de7e2e726802c4d0c9b1f613104282a9e3285d2a7ead3a66b9f683a953dd9d1
---

# Projects and onboarding

A first-run setup that readies the sandbox, Claude Code and the orchestrator's model, then projects:
one target each, created through a guided setup, holding tasks that share its sandboxes, outputs and
analyses.

## Why

Today the desktop app opens on a bare request box: a task names a source folder, and nothing carries
from one task to the next on the same target. The user wants two changes:

- a first-run setup that readies the sandbox, signs Claude Code in on the user's own plan and
  configures an OpenAI-compatible model (OpenRouter by default) before anything else;
- projects created through an intuitive setup, in the spirit of rebuild tools such as craft-anything
  (see the wiki), each with its own UUID and workspace, and with the analyses of earlier tasks kept
  for the later ones.

## Paths

- `src/renderer/src/` — the setup flow, the project views, the sidebar, new shadcn/ui components
- `src/main/` — setup state, projects, project-scoped sandboxes and analyses, the runner
- `src/shared/` — the IPC contract and types
- `resources/` — the app icon and artwork, made with pixellab-cli

## References

- `specs/onboarding/` — the first-run setup: sandbox images, Claude Code sign-in, and the orchestrator's provider, key and model, with project creation locked until all three are ready
- `specs/projects/` — projects with a UUID and a folder, a guided setup (goal, target with its detected kind, model and effort), tasks inside a project sharing its sandboxes, outputs and analyses, and existing tasks moved into projects
- Delivered in order: specs/onboarding, then specs/projects
- adr:0010-build-the-renderer-on-shadcn-ui-and-radix
- adr:0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted
- adr:0014-add-openai-compatible-orchestrator-providers

## Out of scope

- The terminal UI, which follows the same flow in a later plan
- Copying another app's wording, branding or artwork
- Sharing projects between machines or users

## Tasks

- [x] 1.1 (Unit) Make the app icon and the setup and project artwork with pixellab-cli, and wire the icon into the window and the installer
- [ ] 1.2 (Unit) Rebuild the task view as a chat timeline that tracks each agent's
      turns, tool calls and delegations in line, as Claude Code Web and Codex Web show a
      run
  _Reason The user asked for the run shown as a chat timeline, closer to Claude Code Web and Codex Web_

## Done when

- `scc validate --checks --pr` exits 0 with both referenced specs' tasks ticked
- A fresh install opens on the setup, and only a finished setup opens project creation
- A project created from an APK shows its detected kind, and a second task in it reads what the first one found
