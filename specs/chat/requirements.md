---
autonomy: auto
ci: wait
branch: feat/chat-hitl
delivery: in-review
pr: 2
---

# Chat — requirements

## Purpose

Turn a task from one request and one answer into a conversation the user stays in: a
multi-turn chat on the task's thread, where the user sends follow-up messages while
the agent works, stops and continues a run, approves, edits or rejects the tool calls
they chose to gate, and answers questions the agent asks mid-run. It sets the division
of labour the harness is built on — the specialist reasons about the target code, the
orchestrator dispatches, organises files and writes code on the specialist's findings
— and gives both agents a way to ask the user. Builds on the orchestrator's interrupt
and checkpointer (specs/orchestrator R3) and the live task view (specs/desktop-ui R2).

## R1 · The conversation

- **R1.1** The chat shall run every turn of a task on one thread keyed by the task id, so each turn resumes the agent's state through the checkpointer rather than starting over.
- **R1.2** When the user sends a message on a task whose turn has ended, the chat shall start a new turn from that message on the same thread.
- **R1.3** The chat shall record each user message and each agent message as events in the task's log, ordered with the task's other events.
- **R1.4** When a turn ends with no interrupt pending, the chat shall mark the task awaiting the user rather than done, and the user's next message continues the conversation.
- **R1.5** The chat shall derive a turn's running, waiting and awaiting-user state from the checkpointer and the event log, so a reopened task shows where the conversation stands.

## R2 · Messages sent mid-turn

- **R2.1** While a turn is running, the chat shall accept a message from the user and deliver it to the agent before its next model call as a user message.
- **R2.2** When the agent reads a message delivered mid-turn, the chat shall record an event the UI shows as the agent having read it.
- **R2.3** The chat shall apply R2.1 to the orchestrator only; a message never reaches a specialist delegation in progress.

## R3 · Stop and continue

- **R3.1** While a turn is running or waiting, the chat shall let the user stop it, aborting the model call and every running delegation and marking the turn stopped.
- **R3.2** When a turn is stopped, the chat shall offer to continue it, and on the user's choice start a turn that resumes from the checkpoint.
- **R3.3** If the agent does not observe a stop within a bounded interval, then the chat shall still mark the turn stopped and release the task's resources.

## R4 · Approving tool calls

- **R4.1** (MODIFIED) The chat shall let the user choose, per task, which of the orchestrator's gated tools pause for a decision before they run, with `apply_patch` always gated unless the user chose to run every tool call without asking.
- **R4.2** When a gated tool is about to run, the chat shall interrupt the turn, record the call with its arguments, and wait for the user's decision.
- **R4.3** The chat shall accept one of approve, edit or reject for a gated call: edit carries replacement arguments the agent runs instead, and reject carries a message returned to the agent in place of the result.
- **R4.4** When the user decides every pending call, the chat shall resume the turn from the checkpointer with those decisions.
- **R4.6** (ADDED) Where the user chose, when starting a task, to run every tool call without asking, the chat shall run each of the orchestrator's tool calls, `apply_patch` included, without pausing for a decision, and keep that choice when the task is retried.
- **R4.5** If a gated call waits longer than the task's approval timeout, then the chat shall reject it and record the decision's origin as the timeout.

## R5 · Asking the user

- **R5.1** The chat shall give the orchestrator a tool to ask the user a question, pausing the turn until the user answers and returning the answer to the agent.
- **R5.2** The chat shall give the specialist a tool to ask the user a question from inside its sandbox, returning the answer across the sandbox boundary to the delegation without granting it any other channel out.
- **R5.3** The chat shall require each question to carry a prompt, a reason, a kind — choice, yes/no, number or free text — and a default, and shall present the input the kind calls for.
- **R5.4** When the user answers a question, the chat shall return the answer and record its origin as the user; if the question is unanswered within its timeout, then the chat shall return the default and record the origin as the timeout.
- **R5.5** The chat shall cap the number of questions an agent may ask within one turn and return the default once the cap is reached.

## R6 · The division of labour

- **R6.1** The orchestrator's instructions shall delegate every analysis of the target's behaviour or structure to the specialist, and the orchestrator shall not state conclusions about the code it has only read itself.
- **R6.2** The orchestrator shall dispatch, organise the files a delegation needs, and write code that builds on the specialist's findings, including scripts it runs to test a hypothesis.
- **R6.3** The orchestrator shall run the code it writes in a writable scratch area in its task container that is separate from the read-only source mount, so no experiment it runs can change the user's files.
- **R6.4** When the orchestrator produces a change to the user's source, the chat shall carry it as a patch through the existing patch approval, leaving the source read-only to the orchestrator.
- **R6.5** The orchestrator shall have only the tools for planning, listing, finding, reading and searching files, writing and running code in its scratch area, delegating to the specialist, proposing and applying a patch, and asking the user; a call to any other tool shall be refused.
- **R6.6** When the orchestrator proposes files from its scratch area as a change to the user's source, the chat shall record them as a patch against the current originals and carry it through the existing patch approval.
- **R6.7** When the orchestrator delegates, the specialist's workspace shall also hold the files the orchestrator names from its scratch area, apart from the source's files and never part of a patch.

## R7 · The chat surface

- **R7.1** The desktop UI shall show the task as a conversation: user and agent messages, the agent's tool calls and results, and its questions, in the order they occurred.
- **R7.2** While a turn is running or waiting, the desktop UI shall keep the message box enabled for a mid-turn message and show the turn's state.
- **R7.3** When a tool call awaits a decision, the desktop UI shall show the call with its arguments and offer approve, edit and reject.
- **R7.4** When the agent asks a question, the desktop UI shall show it with the input its kind calls for and a control to answer.
- **R7.6** (ADDED) The desktop UI shall offer, when a task starts, the choice to run every tool call without asking, stating that it includes changes to the user's source.
- **R7.5** When a turn is stopped, the desktop UI shall offer to continue it; when a turn ends awaiting the user, the desktop UI shall show that it is the user's turn.

## Out of scope

- Resuming a run's exact checkpoint after the app restarts; a continued turn resumes only while the app has kept the task's container (specs/orchestrator out of scope).
- Several tasks sharing one conversation; a thread is one task.
- Streaming the model's tokens as they generate; the UI advances on node updates and recorded events (specs/desktop-ui R2.2).
