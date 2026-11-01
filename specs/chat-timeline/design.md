# Chat timeline — design

## What changes

Serves R1.1–R3.4, with deltas to `specs/event-log/` (paged reads both ways) and `specs/desktop-ui/` (the timeline in the task view).

- `src/main/events/log.ts` — `history(taskId, { beforeEvent | afterEvent, limit })`. Without a
  cursor it returns the newest page; `beforeEvent` the page just older; `afterEvent` the page just
  newer, as today. `hasMore` speaks for the direction asked (R2.1). It also returns `usage`, each
  agent's calls, tokens and cost summed in SQLite over the whole task (R3.3); steps were already
  read whole.
- `src/main/orchestrator/runner.ts`, `tools.ts`, `delegation.ts` — the orchestrator's `tool.call`
  and `tool.result` events carry LangChain's `toolCallId` as `callId`, and a delegation step
  records the `callId` of the call that started it. The timeline pairs a result with its call, and
  a delegation with its call, by that id rather than by counting earlier calls, which a page that
  starts mid-task cannot do (R1.1). Events written before this change still pair by order.
- `src/renderer/src/lib/timeline.ts` (new) — a fold kept between renders: `append(events)` folds
  only the new events into the existing entries (R3.2); `prepend(events)` refolds from the older
  page, which happens once per page the user asks for. Specialist events (any event with a
  delegation's `stepId` whose agent is the specialist) become children of that delegation's entry
  (R1.1, R1.3). `chat.ts`'s `conversation` stays the pure fold the timeline is built on.
- `src/renderer/src/lib/virtual.ts` (new) — the window of entries to render from measured heights,
  an estimate for the rest, the scroll offset and an overscan (R3.1), and the scroll correction
  that keeps content in place when a page is prepended (R2.3).
- `src/renderer/src/views/TaskView.tsx` and `components/chat/` — the timeline rendered through
  the window, rows measured with a `ResizeObserver`, a sentinel at the top that loads the previous
  page (R2.2, R2.3), delegations as cards whose specialist entries are collapsed rows (R1.2), usage
  from `history.usage` and step state from the steps (R3.3).

## Data

`TaskHistory` gains `usage: AgentUsage[]` and `hasOlder: boolean`; `hasMore` keeps meaning newer
events exist after the page. `getTask`'s options gain `beforeEvent`, exclusive of `afterEvent`.

## Alternatives considered

- A virtual-list library: one component's worth of code, against a new dependency and its
  ADR. The window is a pure function, tested in `lib/`.
- CSS `content-visibility: auto` alone: it skips layout and paint off screen but still builds a
  DOM node per entry, which is the cost at 10,000 events.
