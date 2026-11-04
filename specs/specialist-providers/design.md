# Specialist providers — design

## What changes

Serves R1.1–R1.3, R2.1–R2.8. Decided in
adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent, which supersedes
adr:0003-authenticate-the-specialist-with-the-users-claude-plan.

- `src/shared/providers.ts` gains `SPECIALIST_PROVIDERS`: `claude` and every orchestrator provider.
  Settings gain `specialistProvider` (default `openrouter` on its default model) and `specialistModel`. Keys and base URLs
  are the orchestrator's, by provider (adr:0014-add-openai-compatible-orchestrator-providers).
- `src/main/specialist/executor.ts` names what a delegation drives, `Specialist` — `send`, `close`,
  `kill`, `outcome` — which `SpecialistSession` already is.
- `src/main/specialist/mcp.ts` — an MCP client over a child's standard streams: `initialize`,
  `tools/list`, `tools/call`, newline-delimited JSON-RPC, each server a `docker exec -i` into the
  container. Its tools become LangChain tools with the server's JSON schema.
- `src/main/specialist/container.ts` — a DeepAgents sandbox backend over `docker exec` into the
  delegation's container, working directory `/work`.
- `src/main/specialist/agent.ts` — `AgentSpecialist`: the DeepAgents agent, a turn per `send` on
  one thread, its callbacks turned into the stream events Claude Code's reader yields, and the
  inactivity timer.
- `src/main/sandbox/docker.ts` — `mcpServers` (what `mcpConfig` serialises), and
  `agentRunArgs`: the delegation's mounts, detached, `sleep infinity`, no login volume.
- `src/main/delegation.ts` builds the one or the other from Settings and drives it the same way.
  The launcher gains `container`, which starts the delegation's own container or names the sandbox.
- `src/main/readiness.ts` checks the specialist's provider in place of the sign-in when it is not
  `claude`. The Settings views, desktop and TUI, choose the provider and the model.

## Boundaries and contracts

The agent's container keeps the boundary of
adr:0006-run-the-specialist-inside-a-container-per-task: the same mounts, identity and network as
a delegation's Claude Code container, minus the login volume and Claude Code's environment, which
the agent does not use. An MCP server gets its environment from `-e` on its `docker exec`, as
`mcpServers` declares it. The specialist's effort maps onto the orchestrator's reasoning effort,
`max` as `xhigh`.

## Data

An agent's tool events carry `tool`, `callId`, `input`, `output` and `files` as Claude Code's do;
`files` is read from `read_file`, `ls`, `glob` and `grep` (read) and `write_file` and `edit_file`
(write) under `/work`, and from REA's path arguments. The result event carries the turn's tokens
and, on OpenRouter, its cost.

## Risks

- DeepAgents' file tools run helper scripts through the shell; the specialist image is the one the
  orchestrator's container already runs them on.
- An MCP server's process inside the container outlives a killed `docker exec` until its standard
  input closes; the delegation's own container is removed, and in a sandbox the server exits on
  end of input.
