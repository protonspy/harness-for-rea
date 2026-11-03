# Stack

Every adopted technology, with one line on why it earned its place. **Technology
that is not listed here is an open decision, never something adopted silently** —
and because this project's dependency file is structured data rather than source,
that rule is checkable: a direct dependency declared there and absent from here is
reported.

So adding a dependency is a two-step act: add it, and say here why.

```markdown
## Runtime

- **the-http-router** — routing with the standard library's handler contract, no
  framework underneath it.

## Development

- **the-test-runner** — what CI runs; the suite is the gate for a feature.
```

Group however the project actually thinks about it. What matters is that the name
appears and the reason is one line a reader can disagree with.

<!-- Entries go below this line. Delete the guidance above once they read for
themselves. -->

## Runtime

- **Electron** — desktop shell with a Node main process that can spawn and supervise the Claude Code CLI; same base as `study-lab` and the MagnoTech desktop app.
- **electron-vite** — one build for main, preload and renderer, carried over from `study-lab`.
- **TypeScript** — one typed contract shared by main, preload and renderer.
- **React** — renderer UI, as in both reference projects.
- **Tailwind CSS** (with **@tailwindcss/vite**) — renderer styling, as in `study-lab`, themed through shadcn/ui's CSS variables.
- **shadcn/ui** on **radix-ui** — the renderer's components, copied in as source on Radix primitives for keyboard, focus and ARIA behaviour ([adr:0010-build-the-renderer-on-shadcn-ui-and-radix]).
- **class-variance-authority**, **clsx** and **tailwind-merge** — the shadcn/ui helpers for variant classes and merging utilities.
- **lucide-react** — icons, as in `study-lab`.
- **react-markdown** with **remark-gfm** — the conversation's messages and reports as GitHub-flavoured markdown in the desktop app, raw HTML never interpreted (specs/chat R7.6).
- **mdast-util-from-markdown**, **mdast-util-gfm** and **micromark-extension-gfm** — the same markdown parsed to a tree the TUI draws, so both apps read a message alike.
- **@types/mdast** — the types of that tree.
- **Lezer** (`@lezer/highlight`, `@lezer/common` and the `@lezer/javascript`, `python`, `json`, `cpp`, `rust`, `java`, `go`, `html`, `css`, `xml` and `yaml` parsers) — CodeMirror's incremental parsers, coloring the code in a message for both apps from one palette, with no WASM and no DOM.
- **node:sqlite** — built into the Node that Electron bundles, so no native module to rebuild; holds tasks, steps and events ([adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task]).
- **deepagents** — orchestration: planning, delegation tools, filesystem backends and approval interrupts ([adr:0001-use-deepagents-on-openrouter-for-orchestration]).
- **@langchain/openai** — the OpenAI chat client behind the DeepSeek and custom orchestrator providers, which only need a base URL and a key ([adr:0014-add-openai-compatible-orchestrator-providers]); already installed beneath DeepAgents and `@langchain/openrouter`.
- **langchain** — `todoListMiddleware`, which DeepAgents 1.15 no longer adds by default and which provides `write_todos`.
- **@langchain/langgraph** — `MemorySaver` and `Command`, the checkpointer and resume command behind patch approval.
- **langsmith** — a peer dependency of DeepAgents; nothing is sent to LangSmith.
- **@langchain/openrouter** and **@langchain/core** — `ChatOpenRouter`, the model DeepAgents runs on, so the orchestrator is not tied to one vendor.
- **zod** — runtime validation of IPC arguments and tool schemas at the trust boundary.
- **Claude Code CLI (pinned binary)** — the specialist, verified by the signed release manifest and SHA-256 at image build, not an npm dependency ([adr:0002-run-the-specialist-through-the-pinned-claude-code-cli]).
- **Docker** with **node:24.22.2-bookworm-slim** (pinned by digest) — the specialist's base image, one container per delegation ([adr:0006-run-the-specialist-inside-a-container-per-task]); Node runs the ask-user MCP server ([adr:0008-ask-the-user-from-the-specialist-over-the-run-channel]) and the orchestrator's own scripts in `/scratch`. The verifying build stage stays on **debian:bookworm-slim**.
- **Bun** — the TUI's runtime: OpenTUI needs it, and the core runs on it unchanged, `node:sqlite` included ([adr:0022-run-the-tui-on-bun-with-opentui]).
- **OpenTUI** (`@opentui/core`) — the TUI's renderer, a native terminal UI core driven from TypeScript ([adr:0022-run-the-tui-on-bun-with-opentui]).
- **@opentui/react** with **react-reconciler** — the TUI's React layer over OpenTUI, so its screens are declarative and share `src/renderer/src/lib` with the desktop app ([adr:0023-build-the-tui-on-opentuis-react-layer]); its peers `react-devtools-core` and `ws`, which `legacy-peer-deps` does not install, are only loaded by OpenTUI's devtools and stay out.
- **@napi-rs/keyring** — the one OS-keychain store both apps read provider keys from, prebuilt per platform with no install script ([adr:0024-share-the-data-folder-between-processes]).
- **web-tree-sitter** — OpenTUI's required peer, which `.npmrc`'s `legacy-peer-deps` does not install by itself; the TUI's binary and package carry it.
- **GitHub Container Registry** — hosts the specialist's base image, everything but Claude Code, published by the Images workflow and pulled by digest ([adr:0012-pull-the-specialists-base-image-from-ghcr]).
- **Cheat Engine** (on the user's Windows machine, not shipped) — the first MCP integration: the agents read a live process's memory through it, only through the app ([adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations]).
- **The bridge** (`sandbox/cheat-engine/hfr-bridge.lua`) — the app's own read-only fork of `miscusi-peek/cheatengine-mcp-bridge` (MIT) at commit `6bd7ce90`, its write, injection, execution and debugging handlers deleted; upstream fixes come in by hand ([adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations]).

## Development

- **Vitest** with V8 coverage (**@vitest/coverage-v8**) — the delivery gate reads a coverage figure, which `node:test` in `study-lab` does not produce.
- **Vite** and **@vitejs/plugin-react** — what electron-vite builds the renderer with.
- **@types/node**, **@types/react**, **@types/react-dom** — types for the TypeScript build.
- **oxlint** — the lint layer, as in the MagnoTech desktop app.
- **Prettier** — formatting, as in the MagnoTech desktop app.
- **electron-builder** — Windows NSIS installer.
- **CodeQL** (`github/codeql-action`) — code scanning of the TypeScript sources and the workflows in CI, free for a public repository.
