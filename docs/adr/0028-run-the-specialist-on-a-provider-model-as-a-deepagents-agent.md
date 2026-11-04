---
status: accepted
---

# 0028 · Run the specialist on a provider model as a DeepAgents agent on the host

## Context

The specialist is the pinned Claude Code CLI on the user's Claude plan
(adr:0002-run-the-specialist-through-the-pinned-claude-code-cli,
adr:0003-authenticate-the-specialist-with-the-users-claude-plan), in a container per delegation
that sees only the step's files and its prompt
(adr:0006-run-the-specialist-inside-a-container-per-task). In use, Claude declines analysis steps
under its usage policy so often that tasks stall on safeguard refusals
(adr:0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal) and the
orchestrator cannot get its analyses done; the confinement of the container does not change what
the model decides. The user wants the specialist to run on any model of OpenRouter or of an
OpenAI-compatible endpoint, the providers the orchestrator already has
(adr:0014-add-openai-compatible-orchestrator-providers), with the agent on the host and every
execution in the sandbox.

Claude Code speaks only Anthropic's Messages API, so another model behind it needs a translating
gateway and a credential the container can read. The orchestrator already is a DeepAgents agent
on the host whose tools run in a container through `docker exec`
(adr:0007-run-the-orchestrators-tools-in-a-task-container). The specialist's MCP servers — ask-user
over the run channel (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel), REA
(adr:0018-make-rea-native-to-the-specialist) and one per integration
(adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations) — are stdio processes in the image
that speak newline-delimited JSON-RPC.

## Decision

Both agents run on the host and every execution happens in a sandbox bound to `/work`. The
specialist's provider is a setting: one of the orchestrator's providers with a model of it —
OpenRouter on its default model unless the user chooses otherwise, an existing install included —
or the Claude plan, which runs Claude Code in its container as before. On a provider, the specialist is
a DeepAgents agent in the app's process, on the provider's chat model with the provider's key. Its
file tools and its shell run in the delegation's container through `docker exec`: a container of
the delegation's own, started detached on the same mounts and removed when the run ends, or the
orchestrator's sandbox. Its MCP servers are the same ones Claude Code gets, each started in that
container with `docker exec -i` and spoken to over its stdio by a client in the app, so questions
and integration calls still cross the run channel. The prompt, the context package, the contract
and its corrections are the same. Rejected: Claude Code pointed at a translating gateway on the
host, which keeps Claude Code's loop but needs a per-run credential inside the container and a
Messages-to-chat translation of every turn; a translating proxy in the image, which adds a
dependency and the provider's key to the container; and an MCP client library, when three requests
of a line protocol are all the servers need.

## Consequences

- adr:0003-authenticate-the-specialist-with-the-users-claude-plan's rule that the specialist runs
  only on the plan no longer holds: on a provider, source code and the target's data go to that
  provider under its terms, as they already do for the orchestrator.
- No credential enters the container on a provider: the login volume is mounted neither in a
  delegation's own container nor in a sandbox the orchestrator creates while the specialist runs on
  a provider. A sandbox created while it ran on the plan keeps the volume until it is brought up
  again, which recreates it without.
- An existing install moves to Hopper too, since its stored settings never chose a specialist;
  the setup then asks for Hopper's key, and choosing the Claude plan again restores the old path.
- Two specialist loops exist: Claude Code's, read from its stream-json, and DeepAgents', read from
  its callbacks. Both end in the same events and the same result, and a change to either must keep
  them alike.
- The quality of an analysis now depends on the chosen model and on DeepAgents' loop rather than
  on Claude Code's; another model may call tools less reliably.
- A provider model declines in its own words, never with Anthropic's refusal stop reason, so a
  safeguard refusal is recorded only on the Claude plan; on a provider, a declining report reaches
  the orchestrator as a report.
- OpenRouter reports cost; other OpenAI-compatible providers report none, so the specialist's
  cost there is 0.
