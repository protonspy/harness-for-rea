---
autonomy: auto
ci: wait
branch: feat/tui-revamp
delivery: in-review
pr: 17
---

# TUI conversation — requirements

## Purpose

A task in the terminal as a conversation at parity with the desktop app's timeline (specs/chat,
specs/chat-timeline): the same items, folded by the same `src/renderer/src/lib` code, drawn as a
transcript the user follows, steers and reviews from the keyboard. Fixes the conversation defects
and the task's parity gaps of [[tui-0-1-defects]].

## R1 · The transcript

- **R1.1** The TUI shall show a task as a transcript of the user's messages, the agent's messages, tool calls, delegations, questions, decisions and notices, in the order they occurred.
- **R1.2** The TUI shall draw the agent's and the user's messages as markdown, with the code blocks in them colored by the highlighter the desktop app uses (specs/chat R7.6).
- **R1.3** The TUI shall show each tool call on one line with its state, and expand it to its arguments and output when the user opens it.
- **R1.4** The TUI shall show a delegation with its state and objective, and expand it to its context package, the specialist's report with its evidence, the files copied, read and written, and the specialist's run.
- **R1.5** While the user is reading earlier parts of the transcript, the TUI shall keep the view where it is as events arrive, and follow the newest events again once the user returns to the end.
- **R1.6** When the user scrolls to the start of the loaded transcript, the TUI shall load the older page.

## R2 · Turns

- **R2.1** While a turn runs, the TUI shall show a working indicator with the elapsed time and the task's tokens and cost.
- **R2.2** The TUI shall let the user stop a turn, continue a stopped or closed task, close it, cancel it, start it over and delete it, each offered only in the states where it applies.
- **R2.3** If the user deletes a task, then the TUI shall ask for a confirmation first.

## R3 · Decisions

- **R3.1** When a patch is recorded, the TUI shall show its diff with its files, and let the user approve or reject it while it waits.
- **R3.2** When a gated tool call waits on a decision, the TUI shall show the call with its arguments and let the user approve it, edit its arguments or reject it with a reason.
- **R3.3** When an agent asks a question, including the choice after a safeguard refusal, the TUI shall show it in a dialog with the input its kind calls for, its reason and its default.

## R4 · The prompt

- **R4.1** The TUI shall take a message in a multi-line prompt: Enter sends, and Shift+Enter or Ctrl+J starts a new line.
- **R4.2** The prompt shall keep the messages sent this session, Up and Down at its first and last line recalling them.
- **R4.3** When the user types `@` in the prompt, the TUI shall complete a path from the files of the project's target folder.
- **R4.4** While a turn runs, the TUI shall send a message to the task as a message the agent reads before its next step, and show it as not read until then.

## Out of scope

- Streaming the model's tokens as they are generated (specs/chat out of scope).
- Editing a message already sent.
