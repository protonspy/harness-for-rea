---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: in-review
pr: 13
---

# Vector replay — requirements

## Purpose

Lets the orchestrator check that its reimplementation behaves as the target does, on evidence rather
than on reading: the specialist runs the original in its sandbox and records what it observed as
test vectors in the analysis contract, and the orchestrator replays them against its own code in the
task's sandbox. Drawn from [[craft-anything]]'s observed vectors; for the orchestrator porting or
reimplementing a target, and the user checking that it did.

## R1 · Recording

- **R1.1** The specialist's instructions shall ask it to record test vectors only from running the target in its sandbox, never from reading the code, with the command it ran as each vector's source.
- **R1.2** The analysis contract shall carry each recorded test vector with a name, its arguments, its standard input, the standard output and exit code observed, and its source.

## R2 · Replay

- **R2.1** The orchestrator shall have a tool that replays an analysis's test vectors against a command it names, running each vector in the task's sandbox.
- **R2.2** When a vector is replayed, the tool shall give the command the vector's arguments and standard input and compare its standard output and exit code with the ones recorded.
- **R2.3** When a replay ends, the tool shall return each vector's outcome with what differed, and record how many passed and failed as an event.
- **R2.4** If the analysis is not one of the task's or its project's, or it recorded no vectors, then the tool shall refuse and say why.
- **R2.5** The tool shall pass a vector's arguments and standard input to the shell only as encoded data, never as command text.

## Out of scope

- Replaying vectors against the target itself, or in the specialist's sandbox.
- Fuzzy comparison: outputs match byte for byte.
