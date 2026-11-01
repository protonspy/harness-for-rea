# Specialist lifecycle — design

## What changes

Serves R1.1–R3.2, under adr:0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal.

- `src/main/orchestrator/answer.ts` (new) — `answerFromPackage(model, pkg, question)`: one call of
  the task's chat model with a system prompt that holds the context package and the question, asking
  for JSON `{"answer": …}` or `{"defer": "…why…"}`. The reply is parsed and checked with
  `checkAnswer`; anything else is a deferral (R1.1, R1.3).
- `src/main/orchestrator/runner.ts` — `ask` for the specialist tries `answerFromPackage` first with
  the step's stored `context`. A model answer is recorded as `question.asked` and `question.answered`
  with origin `orchestrator` and does not count against the cap; a deferral goes to the user as
  before (R1.2, R1.3). `refusal(taskId, stepId, message)` records the choice the user must make as a
  `question.asked` of kind choice — so the chat's question card shows it — with no timeout and no cap,
  then, for a different approach, a text question the same way (R2.2, R2.3). Stopping cancels the
  task through `cancel` (R2.5).
- `src/main/specialist/stream.ts`, `executor.ts` — a refusal is recognised from an assistant message
  whose `stop_reason` is `refusal`, or a result whose text says the request violates the usage
  policy. `FailureKind` gains `refused` (R2.1).
- `src/main/delegation.ts` — a `refused` run is logged as `safeguard.refusal` with step state
  `refused`, and `delegate` throws `SafeguardRefusal` carrying the step (R2.1).
- `src/main/orchestrator/tools.ts` — `delegate_to_specialist` catches `SafeguardRefusal`, asks the
  runner for the user's choice through the tool context, and returns the refusal and the choice as
  text naming it a safeguard refusal and forbidding a reworded or justified re-delegation (R2.4,
  R2.6).
- `src/main/sandbox/docker.ts` — `SPECIALIST_MODEL` is the full Opus id passed to `--model` (R3.2);
  the container's `--rm` and the kill on every end were already there and gain a test per ending
  (R3.1).
- `src/shared/` — `Origin` gains `orchestrator`, `TaskState` gains `refused` for steps.
- Renderer — the notice and the step badge for `safeguard.refusal` and `refused`; the question card
  already renders the choice.

## Alternatives considered

- A separate IPC method and card for the refusal choice: the question card already does choice and
  text with the user's answer recorded; a second surface would duplicate it.
