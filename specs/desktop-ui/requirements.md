---
autonomy: auto
ci: wait
branch: feat/harness-for-rea
delivery: in-review
pr: 1
---

# Desktop UI — requirements

## Purpose

The React renderer through which the user configures the app, starts a task on a
source folder, watches it decompose and delegate in real time, inspects the
evidence and the files each delegation touched, decides on proposed patches, and
looks back at past tasks with what they cost.

## R1 · Settings

- **R1.1** The desktop UI shall let the user set or clear the OpenRouter key, pick the orchestrator model with the preset offered, choose the reasoning effort of the orchestrator and of the specialist, set the delegation timeout and resource limits, and toggle discard on completion.
- **R1.2** The desktop UI shall show whether Docker is running, whether the sandbox images are ready or being prepared, and whether the specialist is signed in, with actions to prepare the images again and sign in.
- **R1.3** While the specialist sign-in is in progress, the desktop UI shall show the Anthropic URL to open and a field for the code.

## R2 · Tasks

- **R2.1** When the user submits a request with a source folder, the desktop UI shall start a task and show it in the task list.
- **R2.2** While a task runs, the desktop UI shall show its todos, each delegation with its agent and state, and the event log as events arrive.
- **R2.3** The desktop UI shall show for each delegation its context package, the specialist's report with its evidence, and the files copied, read and written.
- **R2.4** When a patch awaits approval, the desktop UI shall show its diff with approve and reject actions.
- **R2.5** The desktop UI shall show tokens and cost per agent and per task, marking the specialist's cost as an estimate.
- **R2.6** While a task is running or waiting, the desktop UI shall let the user cancel it.

## R3 · History

- **R3.1** The desktop UI shall list past tasks with their state, time and cost, open any of them with its full event history, and retry an interrupted or failed one.
