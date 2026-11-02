---
status: accepted
---

# 0023 · Build the TUI on OpenTUI's React layer

## Context

adr:0022-run-the-tui-on-bun-with-opentui put the terminal UI on Bun and OpenTUI's core, and the 0.1
TUI drove `@opentui/core`'s renderables imperatively: one class per screen that adds, removes and
rewrites nodes by hand. plans/tui-revamp asks for a TUI at parity with the desktop app — a status
line, a transcript of markdown, collapsible tool calls and delegations, diffs, dialogs, a command
palette, a sidebar and every setup and settings screen — and every one of those is state drawn
into a tree that changes as pushes arrive. [[tui-0-1-defects]] lists what the imperative version
got wrong at a fraction of that size: lists that lose their place on every push, a whole timeline
redrawn as one text block, errors replaced by the next redraw.

OpenTUI ships two declarative layers over the same core: `@opentui/react`, a React reconciler,
and `@opentui/solid`, the one OpenCode's TUI is written on. Both render the same renderables —
`box`, `text`, `scrollbox`, `textarea`, `select`, `code`, `markdown`, `diff` — and both come with
a test renderer that draws a frame into a string and takes simulated keys.

The desktop app's renderer is React, and its view logic is already pure and framework-free in
`src/renderer/src/lib/`: the timeline that folds events into chat items (`timeline.ts`,
`chat.ts`), the history store that folds pushes (`store.ts`), the virtual window over a long list
(`virtual.ts`) and the formatting of tokens, costs and durations (`format.ts`).

## Decision

The TUI is rewritten on `@opentui/react` 0.8.1, with React 19 and `react-reconciler` 0.33, still
on Bun. It imports the pure modules of `src/renderer/src/lib/` as they are — `timeline`, `chat`,
`store`, `virtual`, `format` and `projects` — so a task reads the same in both apps and a fix to
how events become a conversation lands in both. The desktop app's React components are not
shared: they render DOM and Tailwind classes, and the TUI's render renderables. The JSX of
`tui/` compiles with `jsxImportSource: "@opentui/react"`, set in `tsconfig.tui.json` and in the
root `tsconfig.json` Bun reads.

Screen tests run under `bun test` on `@opentui/react/test-utils`' `testRender`, with simulated
keys, against a scripted API: the TUI's views take the API as a prop, so a test drives them with
no core and no Docker.

Rejected:

- **The imperative core API, kept.** Every screen would keep reimplementing what a reconciler
  does — diff the tree, keep focus and selection, unmount what left — and the 0.1 defects are
  that work done by hand.
- **`@opentui/solid`**, OpenCode's choice. Fine-grained reactivity suits a transcript, but it is
  a second component model in a repository whose renderer, tests and contributors are React's,
  and it shares nothing with `src/renderer` beyond the pure modules React shares as well.

## Consequences

- The TUI gains `@opentui/react` and `react-reconciler` as dependencies; React is already one.
  Its peers `react-devtools-core` and `ws` are not installed — `.npmrc`'s `legacy-peer-deps`
  skips them — and are loaded only when OpenTUI's `DEV` devtools are switched on, which the
  TUI never does; the binary build marks them external.
- `src/renderer/src/lib/` must stay free of DOM and of React DOM: it is now imported by a
  process that has neither.
- OpenTUI's React layer is as young as its core (0.x); an upgrade is a tested change, and the
  screen tests are what test it.
- Screen tests run under Bun rather than Vitest, so CI runs both and the gate sums them
  (plans/tui-revamp 1.5).
