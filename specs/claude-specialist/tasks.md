# Claude specialist — tasks

## 1 · Stream and process

- [x] 1.1 (Unit) Read stream-json lines into events with subagent attribution, size caps, usage and cost, unknown types kept, and `/work` paths mapped back — R2.1, R2.2, R2.3, R2.4, R2.5
- [x] 1.2 (Unit) Write the fake Claude Code CLI fixture that reads stream-json turns, uses file tools over its working directory and prints stream-json — R1.2, R2.1
- [x] 1.3 (Unit) Start a prepared launch, send turns on stdin, collect results, forward raw lines, and classify failures — R1.1, R1.2, R1.4
  _Depends 1.1, 1.2_
- [x] 1.4 (Unit) Stop the launch and its process tree on cancel or timeout and report the outcome — R1.3
  _Depends 1.3_
- [x] 1.5 (Unit) Pass the chosen effort to Claude Code as `--effort` through the launcher — R1.5
  _Depends 1.3_

- [x] 1.6 (TDD) Time a delegation out on inactivity rather than on the clock: restart the timer on every output line, hold it while a tool call is open or no turn is pending, and label the setting as an inactivity timeout — R1.3, R1.6
  _Depends 1.4_
  _Reason Long analyses were cut mid-work by the wall-clock timeout_

- [x] 1.7 (TDD) Bound what inactivity alone does not: stop a delegation whose tool call stays open past the MCP tool timeout with no other call moving, count only lines with stream events as activity, leave a subagent's own call out of the open calls, and stop a CLI that does not exit after its stdin ends — R1.6, R1.7, R1.8
  _Depends 1.6_
  _Reason The code and security reviews of 1.6 found ways a delegation could now run forever_

## 2 · Login

- [x] 2.1 (Unit) Report login state and run the subscription login through the sandbox image, exposing only an Anthropic URL — R3.1, R3.2
  _Depends 1.3_
