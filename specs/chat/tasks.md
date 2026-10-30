# Chat — tasks

- [x] 1.1 (Unit) Add the chat IPC methods and their zod schemas, and the shared question kinds, default and cap — R5.3, R7.1, R7.2, R7.3, R7.4, R7.5
- [x] 2.1 (TDD) Keep a task's agent, thread and container alive past a turn, leaving it awaiting-user, and start a new turn from a later message on the same thread — R1.1, R1.2, R1.4
  _Depends 1.1_
- [x] 2.2 (Unit) Record user and agent messages as ordered events, and derive the turn state from the checkpointer and the log on reopen — R1.3, R1.5
  _Depends 2.1_
- [x] 3.1 (TDD) Deliver a mid-turn message to the orchestrator before its next model call and record a read event, never reaching a running delegation — R2.1, R2.2, R2.3
  _Depends 2.1_
- [x] 4.1 (TDD) Make stop non-terminal — abort the model call and delegations, settle a stop the stream misses — and continue a stopped turn from the checkpoint — R3.1, R3.2, R3.3
  _Depends 2.1_
- [x] 5.1 (TDD) Build interruptOn from the task's chosen gated set with apply_patch always gated, and resume with approve, edit or reject decisions — R4.1, R4.2, R4.3, R4.4
  _Depends 1.1, 2.1_
- [x] 5.2 (TDD) Reject a gated call past the approval timeout, recording the origin as the timeout — R4.5
  _Depends 5.1_
- [x] 6.1 (TDD) Give the orchestrator an ask_user tool that pauses for the answer, returns the default on timeout, and caps questions per turn — R5.1, R5.4, R5.5
  _Depends 1.1, 2.1_
- [x] 7.1 (TDD) Bake the ask-user MCP server into the specialist image and register it on claudeArgs, with the run-directory channel mount — R5.2
  _Depends 1.1_
- [x] 7.2 (TDD) Carry a specialist question across the run channel to the chat and its answer back, redacted and bounded — R5.2
  _Depends 7.1, 6.1_
- [x] 8.1 (Unit) Instruct the orchestrator to delegate every analysis and state no conclusion about code it only read — R6.1
- [x] 8.2 (TDD) Give the orchestrator container a writable /scratch separate from the read-only source, so execute writes there and never to the source — R6.2, R6.3, R6.4
  _Depends 8.1_
- [x] 9.1 (Unit) Render the task as a conversation of messages, tool calls and results with the message box enabled while a turn runs — R7.1, R7.2
  _Depends 1.1_
- [x] 9.2 (Unit) Show the approve/edit/reject card, the per-kind question card, and the stop, continue and your-turn controls — R7.3, R7.4, R7.5
  _Depends 9.1_
- [x] 9.3 (Unit) Build the renderer on shadcn/ui and Radix with its theme tokens — R7.1,
      R7.2, R7.3, R7.4, R7.5
  _Depends 9.1_
  _Reason The user asked for shadcn/ui (adr:0010-build-the-renderer-on-shadcn-ui-and-radix)_
- [x] 8.3 (TDD) Hold the orchestrator to its tool allowlist — R6.5
  _Depends 8.2_
  _Reason A run analysed an APK itself instead of delegating (adr:0011)_
- [x] 8.4 (TDD) Give the orchestrator propose_patch — R6.6
  _Depends 8.3_
  _Reason The orchestrator had no way to hand its own code to the user_
- [x] 8.5 (Unit) Let the orchestrator read the user's code — R6.5
  _Depends 8.3_
  _Reason The orchestrator is a coding assistant and must read the code it integrates with_
- [x] 8.6 (TDD) Carry the orchestrator's scratch files into a delegation — R6.7
  _Depends 8.4_
  _Reason The orchestrator prepares the scenario for the analysis, harnesses and its own code included_

## Done when

- A task is a multi-turn conversation: the user sends follow-ups, stops and continues a run, and a reopened task shows where it stands.
- The user approves, edits or rejects the tool calls they chose to gate, and both agents can ask the user a question that pauses until answered or defaulted.
- The orchestrator delegates all analysis, writes and runs code only in /scratch, and reaches the user's source only as a patch through approval.
