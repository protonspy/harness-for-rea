# TUI conversation — design

## What changes

Serves R1–R4, reusing `src/renderer/src/lib`: `Timeline` folds events into chat items, `blocks()`
groups them, `fold()` keeps the history current from pushes, `stepOf()` and the specialist's run
come from `timeline.ts`, `usageByAgent`, `filesOfStep` and `canRetry` from `store.ts`, and the
formatting from `format.ts` — the same code the desktop app's task view runs.

- `tui/src/app/useTask.ts` — a task's history and timeline, loaded a page at a time (400 events),
  folded from pushes, older pages prepended on request (R1.6).
- `tui/src/screens/Task.tsx` — the transcript in a `scrollbox` with sticky scrolling to the bottom:
  OpenTUI stops following when the user scrolls up and follows again at the end (R1.5). Reaching the
  top loads the older page (R1.6). Tab moves the focus between the prompt and the transcript; in the
  transcript, Up and Down select an item and Enter expands it; Ctrl+O expands every tool call
  (R1.3, R1.4).
- `tui/src/lib/markdown.ts` (new, pure) — markdown parsed with `mdast-util-from-markdown` and its
  GFM extension into blocks of styled runs: paragraphs, headings, lists, quotes, code, tables and
  rules. `components/Markdown.tsx` draws them; a code block's lines come from `highlight()` and are
  colored from `SYNTAX` (R1.2).
- `tui/src/lib/transcript.ts` (new, pure) — the one-line summary of a tool call, a delegation's
  sections, the working line's text, which actions a task's state offers (R1.3, R1.4, R2.1, R2.2).
- `components/Diff.tsx` — a patch's files and its diff, lines colored by `diffLines` (R3.1).
- Dialogs: a question by kind (choice, yes or no, number, text) with its reason and default, the
  safeguard refusal's choice among them (R3.3); a gated call's approve, edit (its arguments as JSON
  in a textarea) and reject with a reason (R3.2); delete confirmed (R2.3).
- `components/Prompt.tsx` — an OpenTUI `textarea` with Enter bound to submit and Shift+Enter and
  Ctrl+J to a new line (R4.1); `lib/history.ts` the session's sent messages (R4.2);
  `lib/mentions.ts` lists the target folder's paths matching what follows `@`, skipping
  `node_modules` and `.git`, capped at 50 (R4.3). A message sent during a turn goes to
  `sendMessage` as in the desktop app, and the timeline shows it unread until `message.read`
  (R4.4).

## Data

Nothing new crosses the API: every action is a method the desktop app's task view calls.
