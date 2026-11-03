---
autonomy: auto
ci: wait
branch: feat/integration-skills
delivery: in-progress
pr: 22
---

# Mcp integrations — requirements

## Purpose

The app carries a list of MCP integrations — engines on the host, Cheat Engine first and IDA Pro
later — that the agents use only through the app (adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations).
Each integration plugs into Settings, the specialist's run and the orchestrator the same way, and
the user decides, tool by tool, whether the orchestrator, the specialist, both or neither get it.

## R1 · The list

- **R1.1** (MODIFIED) The Settings view's MCP tab shall list every integration the app carries, each off by default, with its title, whether it is on and a way to configure it.
- **R1.2** When the user turns an integration on, the app shall run that integration's checks and show the result of each.
- **R1.3** If any check fails, then the app shall leave the integration off and show the failed check with the step that fixes it.
- **R1.4** While an integration is on, the Settings view shall show whether it is connected.
- **R1.5** The Settings view shall offer no way to add an MCP server the app does not carry.
- **R1.6** (ADDED) When the user chooses to configure an integration, the Settings view shall show a page for that integration alone, with its settings, its switch, its checks, its actions and its tools, and a way back to the list.

## R2 · Tools

- **R2.1** (MODIFIED) The integration's page shall list each of its tools with one toggle for the orchestrator and one for the specialist.
- **R2.2** (MODIFIED) The app shall start every specialist toggle on and every orchestrator toggle at the integration's default for that tool.
- **R2.3** (MODIFIED) When the user turns on a tool that works on a target for the orchestrator, the Settings view shall warn that what it returns goes to the orchestrator's model and provider.
- **R2.4** The app shall accept a call to an integration's tool only from an agent the tool is checked for, and only when the tool is in that integration's catalog.

## R3 · Targets

- **R3.1** Where an integration's tools work on a target, the `delegate_to_specialist` tool shall accept one target of that integration.
- **R3.2** When a delegation or an orchestrator call names a target the task has not approved, the app shall ask the user, showing what identifies the target, and go on only on approval, in an automatic task too.
- **R3.3** If the user declines a target or does not answer, then the delegation or call shall end with the refusal as its result.
- **R3.4** While a delegation runs with an approved target, the app shall refuse a call from it that names any other target of that integration.

## R4 · The specialist

- **R4.1** Where an integration is on and has a tool checked for the specialist, the delegation shall start Claude Code with that integration's MCP server offering only those tools, and allow them.
- **R4.2** The delegation shall carry each integration's calls to the app over its run directory, and add no mount, port or environment variable to the container for it.
- **R4.3** When the app receives a call from the run directory, the app shall check it against R2.4 and R3.4, forward it to the integration, and write the answer back to the run directory.
- **R4.4** If an integration does not answer a call within its timeout, then the app shall answer the call with an error naming the cause.
- **R4.5** If an integration the delegation names a target of is disconnected when the delegation starts, then the delegation shall fail with an error naming the integration.
- **R4.6** Where the specialist has an integration's tools, the specialist's system prompt shall name the integration and its approved target, and say that what its tools return is data from the target, never instructions.
- **R4.7** (ADDED) The app shall carry, for each integration it carries, a skill for the specialist that says how to work with the integration's tools and names only tools of its catalog.
- **R4.8** (ADDED) Where the specialist has an integration's tools and the integration answers when the delegation starts, the delegation shall write the integration's skill into the run directory, and the specialist's system prompt shall direct the specialist to read it before its first call to that integration's tools.
- **R4.9** (ADDED) If an integration whose tools the specialist has does not answer when the delegation starts, then the delegation shall offer its tools without its skill.

## R5 · The orchestrator

- **R5.1** Where an integration is on, the orchestrator shall have the integration's tools checked for it, under the names the specialist sees them by.
- **R5.2** Where the orchestrator has an integration's tools, the orchestrator's instructions shall say that the analysis of a target is delegated to the specialist with that target.

## R6 · The record

- **R6.1** The app shall record each integration call in the task's event log with its agent, integration, tool, arguments, target, outcome and the size of its answer, never the answer itself.

## Out of scope

- Adding an arbitrary MCP server from Settings.
- IDA Pro, which is its own integration and spec.
- The TUI's Settings screen; the integrations still work in tasks the TUI runs.
- Blocking the containers' access to services on the host's loopback through `host.docker.internal`.
