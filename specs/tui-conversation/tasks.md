# TUI conversation — tasks

## 1 · The transcript

- [x] 1.1 (Unit) Parse markdown into blocks of styled runs and draw them, code blocks colored by the shared highlighter — R1.2
- [x] 1.2 (Unit) Draw the transcript from the shared timeline: messages, tool calls on one line that expand, delegations with their sections and run, questions, decisions and notices — R1.1, R1.3, R1.4
  _Depends 1.1_
- [x] 1.3 (Unit) Follow the newest events unless the user scrolled up, and load the older page at the top — R1.5, R1.6
  _Depends 1.2_

## 2 · Turns and decisions

- [x] 2.1 (Unit) Show the working line with elapsed time, tokens and cost, and offer stop, continue, close, cancel, start over and delete where the state allows, delete confirmed — R2.1, R2.2, R2.3
  _Depends 1.2_
- [x] 2.2 (Unit) Show patches as diffs with approve and reject, gated calls with approve, edit and reject, and questions in dialogs by kind — R3.1, R3.2, R3.3
  _Depends 1.2_

## 3 · The prompt

- [x] 3.1 (Unit) Take multi-line messages with history and `@` path completion, sent mid-turn as unread messages — R4.1, R4.2, R4.3, R4.4
