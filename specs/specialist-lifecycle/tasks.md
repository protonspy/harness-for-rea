# Specialist lifecycle — tasks

## 1 · Questions

- [x] 1.1 (Unit) Answer a specialist's question from the context package with one call of the orchestrator's model, deferring on anything that does not fit — R1.1, R1.3
- [x] 1.2 (TDD) Route the specialist's questions through the model first, recording the origin and keeping the cap to the user's questions — R1.2, R1.3
- [x] 1.3 (Unit) Leave questions about authorization, ownership or purpose to the user, mark the question as untrusted for the model, and cap the model's answers per turn — R1.4
  _Reason The security review found a hostile target could steer the specialist to ask the model what only the user may answer_

## 2 · Safeguard refusal

- [x] 2.1 (TDD) Recognise a safeguard refusal in Claude Code's output and record it as its own event kind and step state — R2.1
- [x] 2.2 (TDD) Wait on the user's choice with no timeout or cap, cancel on stop, and tell the orchestrator the refusal and the choice — R2.2, R2.3, R2.4, R2.5, R2.6
- [x] 2.3 (Unit) Show the refusal's notice and step state in the timeline — R2.1

## 3 · Container and model

- [x] 3.1 (Unit) Pin the specialist to the full Opus model id, and check no container of a delegation's own outlives any ending — R3.1, R3.2
