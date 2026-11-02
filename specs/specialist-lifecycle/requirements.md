---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: merged
pr: 13
---

# Specialist lifecycle — requirements

## Purpose

What happens around one run of the specialist so that it never stalls a task for nothing: its
questions answered by the orchestrator's model when the context package already holds the answer,
a safeguard refusal kept apart from every other failure and settled by the user's choice, and its
container and model pinned down. Decided in
adr:0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal; for the user
running tasks and for the orchestrator that reads each delegation's outcome.

## R1 · Questions

- **R1.1** When the specialist asks a question, the delegation shall put it to one call of the orchestrator's model with the delegation's context package and the question, outside the task's conversation.
- **R1.2** When the orchestrator's model answers with an answer that fits the question's kind, the delegation shall return it to the specialist and record the question and answer with the orchestrator as the origin.
- **R1.3** If the orchestrator's model defers to the user, answers with something that does not fit the question, or the call fails, then the delegation shall put the question to the user.
- **R1.4** If a question is about authorization, ownership or purpose, or the turn has already put its share of questions to the orchestrator's model, then the delegation shall put it to the user without asking the model.

## R2 · Safeguard refusal

- **R2.1** When the specialist declines a step under its usage policy, the delegation shall record a safeguard refusal with its own event kind and step state, distinct from the app's `sandbox.refused` and from a failure.
- **R2.2** When a safeguard refusal is recorded, the task shall wait for the user to choose to stop the task, skip the step, or ask for a different technical approach in their own words.
- **R2.3** While a safeguard refusal waits on the user, the task shall apply no timeout to the choice and shall not count it against the question cap.
- **R2.4** When the user chooses to skip the step or to take a different approach, the delegation shall tell the orchestrator that the step was a safeguard refusal and what the user chose.
- **R2.5** When the user chooses to stop the task, the task shall be cancelled.
- **R2.6** The delegation shall never reword a refused request nor add a purpose or authorization to the brief.

## R3 · Container and model

- **R3.1** When a delegation's run ends in an answer, a failure, a cancellation, a timeout or a refusal, the delegation shall leave no specialist container of its own behind.
- **R3.2** The delegation shall run the specialist on the pinned Opus model, by its full model id.

## Out of scope

- Rewording a refused request, or retrying it unchanged, so the specialist accepts it.
- Answering the specialist's questions from anything but the delegation's own context package.
