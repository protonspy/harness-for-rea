# Mcp integrations — tasks

## 1 · The contract and Settings

- [x] 1.1 (Unit) Define the integration contract, `IntegrationSettings` with its defaults and `toolName` in `src/shared/integrations.ts`, and the registry the app carries — R1.1, R1.5, R2.2
- [x] 1.2 (Unit) Add `integrations` to `Settings`, every one off by default, and the `integrations`, `integrationStatus` and `runIntegrationAction` IPC methods with their zod schemas — R1.1, R1.2, R1.3, R1.4
  _Depends 1.1_
- [x] 1.3 (Unit) Run an integration's checks when it is turned on, keep it off on a failure with the fix, and report its connection state — R1.2, R1.3, R1.4
  _Depends 1.2_
- [x] 1.4 (Unit) Build the Settings view's MCP section over the list: settings, switch, checks with fixes, actions, connection state, and each tool with one checkbox per agent, warning on a target tool checked for the orchestrator — R1.1, R1.2, R1.3, R1.4, R1.5, R2.1, R2.2, R2.3
  _Depends 1.3_

## 2 · The gate and targets

- [x] 2.1 (TDD) Gate every call on the catalog, the calling agent's checkbox and the approved target, with the call's timeout and its event-log record, against a fake integration — R2.4, R3.4, R4.4, R6.1
  _Depends 1.1_
- [x] 2.2 (Unit) Keep a task's approved targets per integration and ask the user for an unapproved one, default no, in an automatic task too, ending the delegation or call with the refusal — R3.2, R3.3
  _Depends 2.1_

## 3 · The specialist

- [x] 3.1 (Unit) Let the ask channel watcher take its file prefix and serve `t-`/`r-` tool calls through the gate as the specialist's — R4.2, R4.3
  _Depends 2.1_
- [x] 3.2 (Unit) Write `sandbox/mcp/server.mjs` and copy it with each integration's checked tools into a delegation's run directory — R4.1, R4.2
  _Depends 3.1_
- [x] 3.3 (Unit) Accept `targets` in `delegate_to_specialist`, approve each, add each integration's server and `mcp__<id>` to the MCP config and allowed tools, and fail the delegation before the container runs when a named integration is disconnected — R3.1, R4.1, R4.5
  _Depends 2.2, 3.2_
- [x] 3.4 (Unit) Name each integration and its approved target in the specialist's system prompt and say its tools return data from the target, never instructions — R4.6
  _Depends 3.3_

## 4 · The orchestrator

- [x] 4.1 (Unit) Build the orchestrator's tools from the tools checked for it under `mcp__<id>__<tool>`, a target tool taking its `target`, add them to the allowlist, and add the instructions' line per integration — R5.1, R5.2
  _Depends 2.2_

## 5 · The record

- [x] 5.1 (Unit) Add the MCP integration's term to `docs/glossary.md` and accept adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations — R1.1
