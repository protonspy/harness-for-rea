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
- **node:sqlite** — built into the Node that Electron bundles, so no native module to rebuild; holds tasks, steps and events ([adr:0005-store-events-in-sqlite-with-raw-jsonl-per-task]).
- **deepagents** — orchestration: planning, delegation tools, filesystem backends and approval interrupts ([adr:0001-use-deepagents-on-openrouter-for-orchestration]).
- **langchain** — `todoListMiddleware`, which DeepAgents 1.15 no longer adds by default and which provides `write_todos`.
- **@langchain/langgraph** — `MemorySaver` and `Command`, the checkpointer and resume command behind patch approval.
- **langsmith** — a peer dependency of DeepAgents; nothing is sent to LangSmith.
- **@langchain/openrouter** and **@langchain/core** — `ChatOpenRouter`, the model DeepAgents runs on, so the orchestrator is not tied to one vendor.
- **zod** — runtime validation of IPC arguments and tool schemas at the trust boundary.
- **Claude Code CLI (pinned binary)** — the specialist, verified by the signed release manifest and SHA-256 at image build, not an npm dependency ([adr:0002-run-the-specialist-through-the-pinned-claude-code-cli]).
- **Docker** with **node:24.22.2-bookworm-slim** (pinned by digest) — the specialist's base image, one container per delegation ([adr:0006-run-the-specialist-inside-a-container-per-task]); Node runs the ask-user MCP server ([adr:0008-ask-the-user-from-the-specialist-over-the-run-channel]) and the orchestrator's own scripts in `/scratch`. The verifying build stage stays on **debian:bookworm-slim**.
- **GitHub Container Registry** — hosts the specialist's base image, everything but Claude Code, published by the Images workflow and pulled by digest ([adr:0012-pull-the-specialists-base-image-from-ghcr]).

## Development

- **Vitest** with V8 coverage (**@vitest/coverage-v8**) — the delivery gate reads a coverage figure, which `node:test` in `study-lab` does not produce.
- **Vite** and **@vitejs/plugin-react** — what electron-vite builds the renderer with.
- **@types/node**, **@types/react**, **@types/react-dom** — types for the TypeScript build.
- **oxlint** — the lint layer, as in the MagnoTech desktop app.
- **Prettier** — formatting, as in the MagnoTech desktop app.
- **electron-builder** — Windows NSIS installer.
