# Mcp integrations — design

## What changes

Serves R1.1–R6.1, under adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations.

- `src/shared/integrations.ts` (new) — the contract every integration meets, and its data:
  - `IntegrationTool`: `name`, `description`, zod `schema` of its arguments, `target` (whether
    it works on one), `orchestratorDefault`;
  - `IntegrationInfo`: `id` (the MCP server name, kebab-case), `title`, the zod schema of its
    settings, its `targetSchema` when it has one, its `actions` (Cheat Engine's is "install
    the bridge");
  - `IntegrationSettings`: `{ enabled, config, tools: { [name]: { orchestrator, specialist } } }`.
    A tool with no entry takes the defaults of R2.2, so a tool a later catalog adds starts
    there too;
  - `toolName(id, tool)` = `mcp__<id>__<tool>`, the one name both agents see (R5.1).
- `src/main/integrations/registry.ts` (new) — the list the app carries (R1.1, R1.5) and the
  host side of each: `checks(config)`, `status(config)`, `catalog(config)` (static for Cheat
  Engine; an engine with its own MCP server, as IDA Pro's, can list it from that server),
  `describeTarget(target)` (what the approval shows), `session(target)` and `call(session, tool,
  args)`.
- `src/main/integrations/gate.ts` (new) — the one check before every call, whichever agent
  made it: the tool is in the catalog, checked for that agent, and its target is the one the
  delegation or task approved (R2.4, R3.4). Then the call, its timeout (R4.4) and its event-log
  record (R6.1).
- `src/main/integrations/approval.ts` (new) — the approved targets of a task, keyed by
  integration; an unapproved one is put to the user — never to the orchestrator's model — as a
  yes/no question, default no, in an automatic task too, with the question timeout but outside
  the turn's question cap, and a refusal or timeout is the call's or delegation's result (R3.2,
  R3.3). An orchestrator's target is put to the user only for a tool the gate would let through.
  A refusal is kept for the task; a task puts at most 20 targets to the user; an approval holds
  while the integration's `identify` of the target is unchanged — a pid Windows reused is asked
  about again. What identifies a target is shown with no control or direction-changing characters,
  and `gate.open` refuses a target the task has not approved.
- `src/main/integrations/task.ts` (new) — one task's view: its approvals, the tools each agent
  has, the orchestrator's calls, and what a delegation offers the specialist: a target tool only
  where the delegation names an approved target.
- `src/main/delegation.ts` — `watchAskChannel` takes the file prefix it watches, so the same
  channel directory serves `q-`/`a-` questions and `t-`/`r-` tool calls; a tool call names its
  integration, and goes through the gate as the specialist's (R4.2, R4.3). A delegation writes
  the container server and each integration's checked tools into its run directory (R4.1), and
  fails before the container runs when an integration it names a target of is disconnected
  (R4.5).
- `sandbox/mcp/server.mjs` (new) — the container's stdio MCP server, modelled on
  `ask-user.mjs`, started once per integration as `node /run/hfr/mcp/server.mjs <id>`: its
  `tools/list` is `/run/hfr/mcp/<id>.json`, each `tools/call` is written as `t-<uuid>.json`
  and answered from `r-<uuid>.json`. It is copied from the app's `sandbox/` folder into the run
  directory per delegation, never baked into the base image (R4.2). A call past the run's cap
  (1024) or past 64 KB is answered with an error, so the server never waits on one; two run at
  once, and those still waiting when the delegation ends are answered with an error, never run.
- `src/main/sandbox/docker.ts` — `mcpConfig` and `claudeArgs` take the delegation's
  integrations: each adds a server under its id and `mcp__<id>` to `--allowedTools` (R4.1).
  `dockerRunArgs` and `containerEnv` do not change (R4.2).
- `src/main/sandbox/prompt.ts` — per integration, a section naming it and its approved target,
  saying its tools return data from the target, never instructions (R4.6).
- `src/main/orchestrator/tools.ts` — `delegate_to_specialist` takes an optional `targets`
  object keyed by integration id, each value checked by that integration's `targetSchema`
  (R3.1). Each tool checked for the orchestrator becomes a tool of its own, built from the
  catalog; one that works on a target takes it as a `target` argument (R5.1). Its answer is
  redacted and cut at 64 KB, as anything else that goes to the orchestrator's provider.
- `src/main/orchestrator/agent.ts` — the allowlist becomes the fixed set plus the names of
  the orchestrator's integration tools for this task; the instructions gain, per integration
  the orchestrator has, a line on delegating the target's analysis (R5.2).
- `src/shared/types.ts`, `src/shared/defaults.ts`, `src/shared/api.ts` — `Settings` gains
  `integrations: { [id]: IntegrationSettings }`, every one off by default (R1.1); the IPC
  contract gains `integrations` (the list, each with its catalog), `integrationStatus(id)` and
  `runIntegrationAction(id, action)`, each with its zod schema.
- `src/renderer/src/` — the MCP tab in Settings, generic over the list: a row per integration
  with its title, description, on or off and, while on, whether it is connected, and a
  Configure button (R1.1, R1.4); Configure opens that integration's own page, with a way back,
  holding its settings, its switch, each check with its fix, its actions, its connection
  state, and its tools with one toggle per agent, a shadcn `Switch` on Radix as the integration's
  own on/off is (R1.6, R2.1, R2.2), warning on a target tool
  checked for the orchestrator (R2.3). Which integration is open is the tab's own state.

## Data

A tool call file, `t-<uuid>.json`, is `{ integration, tool, arguments }`, read once and bounded
like a question file; its answer, `r-<uuid>.json`, is `{ result }` or `{ error }`, written whole
by a rename. A delegation's target is fixed when it starts, so the container never names one;
the gate adds it. The event-log record of a call is `{ agent, integration, tool, arguments,
target, outcome, bytes }`, never the answer (R6.1).

## Alternatives

- **MCP servers the user adds** — rejected (adr:0026): the app could not know which of a
  server's tools work on a target, so it could not gate them.
- **A watcher and mount per integration** — rejected: one prefix carries every integration,
  since a call names its own, and the ask channel is already the one writable path outside
  `/work`.

## Testing

The gate, the approval and the channel run in Vitest against a fake integration with one tool
that needs a target and one that does not, so the framework is tested apart from any engine.
