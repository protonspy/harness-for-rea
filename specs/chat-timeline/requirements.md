---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: in-review
pr: 13
---

# Chat timeline — requirements

## Purpose

The task view as a chat timeline in the style of Claude Code Web and Codex Web, built to hold
long runs: a task with tens of thousands of events opens at once, scrolls smoothly, and still
shows each agent's turns, tool calls and delegations, the specialist's own work nested under the
delegation that ran it. It is for the user watching or reviewing a task.

## R1 · The timeline

- **R1.1** The task view shall show the task as a chat timeline: the user's messages, the orchestrator's turns, tool calls and delegations in order, and each specialist's text, thinking and tool calls nested under the delegation that ran them.
- **R1.2** (MODIFIED) The task view shall show each tool call's input and output, each delegation, and each specialist entry's payload — its text, reasoning and tool calls — expanded from the start, each collapsible by the user.
- **R1.3** When a specialist event arrives for a delegation on screen, the task view shall add it under that delegation.

## R2 · Paging

- **R2.1** The event log shall return a task's events in pages before or after a given event id, oldest first within a page, saying whether more exist in the direction asked.
- **R2.2** When a task opens, the task view shall load its newest page of events.
- **R2.3** When the user scrolls to the top of the timeline while older events exist, the task view shall load the previous page and keep what was on screen where it was.

## R3 · Holding long runs

- **R3.1** The task view shall render only the timeline entries near the viewport.
- **R3.2** When events arrive, the task view shall fold only the new events into the timeline.
- **R3.3** The task view shall show each agent's usage and each step's state as the main process reports them for the whole task, never as counted from the loaded events.
- **R3.4** While a task holds over 10,000 events, the task view shall open it in under a second and scroll it within a frame budget.

## Out of scope

- Searching or filtering the timeline.
- Changing what the event log stores: only how it is read.
