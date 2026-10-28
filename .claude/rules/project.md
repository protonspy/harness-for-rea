# This project

Harness for REA: an Electron desktop app (Windows host) where a DeepAgents orchestrator on
OpenRouter delegates deep analysis to Claude Code running in a Docker container per delegation.
Node 24, npm, TypeScript, Vitest. The delivery gate runs these through `scc check`; the commands
below are the same ones, and nothing else is.

## Commands

```bash
# Install (npm 11 skips install scripts; the Electron binary is fetched by its own script)
npm install
node node_modules/electron/install.js

# Build — typecheck both tsconfigs, then electron-vite builds main, preload and renderer into out/
npm run typecheck && npm run build

# Run the app in development
npm run dev

# Test — the whole suite
npm test

# Test — one file (used after every task; scope, not suite)
npx vitest run tests/<file>.test.ts
npx vitest run tests/orchestrator.test.ts -t "<test name>"

# Test — the report the gate reads ({"total": N, "coverage": P}, Vitest's exit status)
node scripts/test-gate.mjs

# Lint — oxlint, warnings fail
npm run lint

# Format / format check — Prettier
npm run format
npm run format:check

# Sandbox images by hand (the app builds them from Settings)
docker build -t hfr-specialist:2.1.310 --build-arg CLAUDE_CODE_VERSION=2.1.310 sandbox/specialist
docker build -t hfr-egress:1 sandbox/egress
```

## Conventions

- **Branch names:** `feat/<slug>`, `fix/<slug>`, `docs/<slug>`
- **Commits:** Conventional Commits, scoped by area: `feat(sandbox): …`, `fix(orchestrator): …`
- **Tests** live in `tests/`, run TypeScript sources directly; `electron` is aliased to
  `tests/electron-stub.ts`. The specialist is `tests/fixtures/fake-claude.mjs`, launched through
  a test `Launcher` instead of Docker; OpenRouter is a scripted `globalThis.fetch`.
- **Coverage** counts `src/main`, `src/shared` and `src/renderer/src/lib`; React views and
  `src/main/index.ts` are checked by running the app.
- **Anything a new contributor gets wrong on their first try:** `npm install` leaves Electron
  without its binary until `node node_modules/electron/install.js` runs; `.npmrc` carries
  `legacy-peer-deps` for DeepAgents beside `langsmith`.

## Boundaries

- `src/main/sandbox/docker.ts` `claudeArgs`, `dockerRunArgs` and `containerEnv` are the
  sandbox boundary (adr:0006-run-the-specialist-inside-a-container-per-task). Do not add a
  mount, an environment variable, a tool or a host fallback without an ADR.
- `CLAUDE_CODE_VERSION` in `docker.ts` and the Dockerfile's pin move together; upgrading the
  pin is a tested change (adr:0002-run-the-specialist-through-the-pinned-claude-code-cli).
- `sandbox/egress/allow` is the egress allowlist; widen it only for a domain Claude Code's
  network requirements list.
- `src/shared/api.ts` is the IPC contract; every method needs its zod schema.
