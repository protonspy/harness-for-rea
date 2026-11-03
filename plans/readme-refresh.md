---
autonomy: auto
ci: wait
---

# Readme refresh

Give the repository a description and topics on GitHub, a banner at the top of the README, and a
README whose diagrams are Mermaid, covering the MCP integrations it does not mention yet.

## Why

The repository has no description or topics, so it cannot be found by what it does, and the README
draws its flows in ASCII and says nothing about the MCP integrations shipped in 0.3.0. Done when
GitHub shows the description and topics and the README renders the banner and its Mermaid diagrams.

## Paths

- `README.md`
- `.github/assets/banner.png`

## References

- `specs/mcp-integrations/` — what the README's integrations section describes
- `specs/cheat-engine/` — the first integration, read-only, Windows only
- `docs/adr/0026-proxy-host-engines-to-the-agents-as-mcp-integrations.md` — why integrations are proxied by the app

## Out of scope

- Hopper request attribution, which is PR 26 and not merged.

## Tasks

- [x] 1.1 (Unit) Set the repository's description and topics with `gh repo edit`
- [x] 1.2 (Unit) Generate the banner with pixellab-cli as a PNG under `.github/assets/` and show it at the top of the README
- [x] 1.3 (Unit) Replace the README's ASCII diagrams with Mermaid and add the task sequence, isolation and shared-core diagrams
- [x] 1.4 (Unit) Add a section on the MCP integrations and Cheat Engine to the README

## Done when

- `gh repo view --json description,repositoryTopics` shows the description and the topics.
- `npx prettier --check README.md` passes and `scc validate` reports no finding for this plan.
- The README renders on GitHub with the banner and every Mermaid diagram.
