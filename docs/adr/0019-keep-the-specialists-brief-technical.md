---
status: accepted
---

# 0019 · Keep the specialist's brief technical

## Context

adr:0007-run-the-orchestrators-tools-in-a-task-container gave the context package a `brief` written
by the orchestrator, and specs/orchestrator R2.7 asked it to state the background and real purpose
of each step: what the system is, who owns it, why the analysis is done. In practice the
orchestrator relays the user's request into it ("the user asked for this, in order to do that").

The user ruled the opposite. The specialist does a deep technical analysis and needs only its
technical scope: the artifact, what is known about it, and what to find. It is isolated by the
files the orchestrator mounts, and its prompt should be limited to the scope of that discovery.
The app's own statement that the artifacts in `/work` are owned by the user or authorized for
analysis (specs/task-sandbox R3.4) is not part of the brief and stays.

## Decision

The brief is technical only. It states:

- what the artifact is: its format, platform, architecture, language, toolchain and versions;
- what is already established about it, with the evidence an earlier delegation returned;
- what the step must map or discover.

It never mentions the user, their request, who they are, what they intend, or why the work is
being done, and it never invents ownership, authorization or purpose. The objective is phrased
the same way: "I have file X and need to map Y". The orchestrator's instructions, the package
schema's description of `brief`, and the glossary say so.

Rejected:

- Dropping the `brief` field, which still carries the technical background the objective alone
  does not.
- Filtering briefs in the app for words like "user", which would also catch technical terms
  such as "user-agent" and "user mode".

## Consequences

- The specialist no longer reads the user's goal, so it cannot weigh one technical path against
  another by what the user wants. The orchestrator has to turn that goal into explicit questions,
  constraints and a report format.
- The rule is held by the orchestrator's instructions alone; nothing in the app rejects a brief
  that relays the user's request.
- R2.7 of specs/orchestrator and the brief consequence of
  adr:0007-run-the-orchestrators-tools-in-a-task-container are replaced by this record.
