# Chat timeline — tasks

## 1 · Reading the log in pages

- [x] 1.1 (Unit) Page `history` before or after an event id, newest page by default, with `hasOlder` and the whole task's usage per agent — R2.1, R3.3
- [x] 1.2 (Unit) Carry the tool call id on the orchestrator's tool events and on the delegation step it starts — R1.1

## 2 · The timeline

- [x] 2.1 (Unit) Fold events into timeline entries incrementally, specialist events nested under their delegation, calls paired by id — R1.1, R1.3, R3.2
- [x] 2.2 (Unit) Compute the rendered window and the prepend scroll correction from measured heights — R2.3, R3.1
- [x] 2.3 (Unit) Render the task view through the window: newest page first, older pages on scroll, payloads collapsed, usage and steps from the main process — R1.2, R2.2, R2.3, R3.3
- [x] 2.4 (Unit) Measure a 10,000-event task in the running app: open time and scroll frame times — R3.4
- [x] 2.5 (Unit) Show tool calls, delegations and the specialist's text, reasoning and tool calls expanded from the start, each collapsible — R1.2
- [x] 2.6 (Unit) Read Claude Code's tool_progress heartbeats into the running call's elapsed time, a few events per long call, never an entry of their own — R1.4
