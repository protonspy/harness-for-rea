---
status: accepted
---

# 0021 · Answer the specialist from the orchestrator, and let the user decide a refusal

## Context

adr:0008-ask-the-user-from-the-specialist-over-the-run-channel sends every question the specialist
asks to the user. In use, most of those questions are about the step itself — which file to start
from, whether a format is the one the brief named, what an earlier delegation found — and the
orchestrator, which wrote the context package, could answer them. Each one still stopped the
delegation until the user came back, or until the question timed out into its default.

plans/specialist-rea.md also planned a safeguard refusal — the specialist declining a step under
its usage policy — as a failure answered by one re-delegation carrying the purpose and
authorization the user states. That collides with adr:0019-keep-the-specialists-brief-technical:
the brief never carries the user's purpose, and a re-delegation reworded until it passes is the
one thing the user ruled out. Meanwhile a refusal came back to the orchestrator as an ordinary
`ERROR:` string, indistinguishable from a crash, and it retried or worked around it on its own.

## Decision

A question from the specialist goes first to one call of the orchestrator's model, with the
delegation's context package and the question, outside the task's conversation. The model either
answers it, and the answer returns over the run channel with its origin recorded as the
orchestrator, or says the question needs a fact only the user has, and only then is it put to the
user as adr:0008 describes. The channel, its files and its bounds are unchanged.

A safeguard refusal is its own state: its own event kind and step state, distinct from the app's
`sandbox.refused`, and the delegation tool tells the orchestrator it was a refusal. The task then
waits on the user, who chooses to stop the task, skip the step, or ask for a different technical
approach in their own words; that choice is what the orchestrator receives. The choice has no
timeout and is not counted against the question cap. Nothing in the app rewords the request or
adds a purpose or authorization to the brief.

Rejected:

- Every question to the user, as before: the cost this record exists to remove.
- Letting the orchestrator answer inside its own conversation: the delegation is one tool call
  mid-turn, and a nested turn on the same thread would interleave with it.
- One automatic re-delegation of a refused step with the user's stated purpose: it contradicts
  adr:0019 and turns a refusal into a rewording loop.

## Consequences

- The user-first part of adr:0008 and the re-delegation sentence of plans/specialist-rea.md are
  replaced by this record; specs/chat R5.2, R5.4 and R5.5 carry the change.
- A question costs one extra model call on the orchestrator's provider, spent even when the
  answer ends up being the user's.
- The orchestrator's model can answer wrongly where the user would have known better. It sees only
  the package it wrote, and it is told to pass anything outside that package to the user.
- A refused task can wait indefinitely; the user's stop or the task's cancel still ends it.
