---
status: accepted
---

# 0010 · Build the renderer on shadcn/ui and Radix

## Context

The renderer began with a handful of primitives written in the shadcn/ui style — a button,
a badge, a card, inputs — and no Radix, because no view needed more than that. The chat
(specs/chat R7) changes the surface: a conversation that scrolls on its own while the
composer stays put, collapsible tool calls, an approval card with an argument editor, a
question card per kind with radio choices and toggles, tooltips on turn controls, and a
side panel of tabs. Each of those is a component with keyboard and focus behaviour and
ARIA roles that are easy to get subtly wrong by hand. The user asked for the app to be
built with shadcn/ui. shadcn/ui is not a dependency: its components are source copied into
the project, built on Radix primitives, `class-variance-authority`, `clsx` and
`tailwind-merge` — the last three already adopted — and themed through CSS variables that
Tailwind v4 maps with `@theme inline`.

## Decision

The renderer's components are shadcn/ui components, kept as source under
`src/renderer/src/components/ui/`, one file each, on the unified `radix-ui` package, pinned.
The theme moves to shadcn/ui's token names (`background`, `card`, `muted-foreground`,
`primary`, `border`, `ring`, `destructive`, …) set to the app's existing dark palette, plus
`success` and `warning` for task states; the app's own names (`panel`, `raised`, `line`,
`ink`) go. Components are added by copying their source, adjusted to the app's density,
not through the shadcn CLI, which assumes a single-root Vite or Next project layout that
electron-vite does not have. Rejected: keeping hand-written primitives, which would mean
writing a scroll area, radio group, tabs and tooltip with their accessibility by hand; and
a styled component library, which ships its own theme and runtime instead of source the
project owns.

## Consequences

- `radix-ui` is a new dependency in `docs/stack.md`; a component that needs another package
  (an animation helper, a date picker) is a new decision, not something pulled in with a copy.
- Every view uses the shadcn/ui token names; a raw color in a view is a finding in review.
- Component source is the project's to change, so an upstream shadcn/ui fix is copied in by
  hand, not upgraded; the copies say what they are and stay close to upstream.
- Radix renders some inline styles; the renderer's CSP already allows inline styles and
  keeps scripts to the app itself.
