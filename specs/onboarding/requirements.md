---
autonomy: auto
ci: wait
branch: feat/projects
delivery: merged
pr: 11
---

# Onboarding — requirements

## Purpose

A first-run setup that readies what every project needs before the user can create one: the sandbox
images with the pinned Claude Code, Claude Code signed in on the user's own plan, and the orchestrator's
OpenAI-compatible model, with OpenRouter as the default gateway. Settings stay where the same choices
are changed later.

## R1 · The setup

- **R1.1** While the setup has never been completed, the desktop UI shall open on the setup instead of the projects.
- **R1.2** The setup shall show three steps in order — the sandbox, the specialist and the orchestrator's model — each with its state, what it needs and the action that readies it.
- **R1.3** The sandbox step shall be ready when Docker answers and the sandbox images are prepared, and shall offer to prepare them, showing the build's progress.
- **R1.4** While the specialist runs on the Claude plan, the specialist step shall be ready when Claude Code is signed in, and shall offer the sign-in with the Anthropic page to open and the field for its code, showing the plan signed in.
- **R1.5** The model step shall start on OpenRouter and let the user pick another OpenAI-compatible provider, set its key and base URL where it takes one, and choose a model from the provider's list or by name.
- **R1.6** (MODIFIED) The model step shall be ready when the provider has a key where it needs one and a model is chosen, and the provider answered with its list of models or, when the list fails other than by refusing the key, a one-token test request to the chosen model answered.
- **R1.7** If a step's check fails, then the setup shall say why and how to fix it, and keep the step not ready.
- **R1.8** When all three steps are ready and the user finishes the setup, the desktop UI shall record the setup as completed and open the projects.

## R2 · After the setup

- **R2.1** While a step that was ready no longer is, the desktop UI shall show which one and a way to fix it, and shall not let a task start, checking a task's start against the provider, key, endpoint and model of its project.
- **R2.2** The setup shall be reachable again from Settings.
- **R2.3** (ADDED) When another app on the same data folder readied a step, the setup shall show the step ready without the user doing it again (specs/shared-data-folder R4, R5).

## Out of scope

- Installing Docker Desktop for the user.
- A model step that runs a chat completion to test the key.
