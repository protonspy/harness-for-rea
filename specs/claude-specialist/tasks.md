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

## 2 · Login

- [x] 2.1 (Unit) Report login state and run the subscription login through the sandbox image, exposing only an Anthropic URL — R3.1, R3.2
  _Depends 1.3_
