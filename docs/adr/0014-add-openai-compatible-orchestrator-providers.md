---
status: accepted
---

# 0014 · Add OpenAI-compatible orchestrator providers

## Context

adr:0001-use-deepagents-on-openrouter-for-orchestration ties the orchestrator to
OpenRouter: one key, one client, OpenRouter's routing fields on every request. The
user wants to run it on a provider key of their own, DeepSeek first, without an
OpenRouter account. DeepSeek, like most hosted and local model servers, implements the
OpenAI chat completions API, so it needs a base URL, an API key and a model name and
nothing more.

## Decision

The orchestrator's model is chosen by a provider setting: `openrouter` (unchanged),
`deepseek`, or `custom`. The last two use `ChatOpenAI` from `@langchain/openai` at the
provider's base URL; DeepSeek is a preset (`https://api.deepseek.com`, `deepseek-chat`)
and `custom` is any other endpoint. A provider is one entry in `src/shared/providers.ts`.
Each provider keeps its own key, encrypted as before; OpenRouter's keeps its original
storage slot so an existing install is unaffected. Reasoning effort is sent as
`reasoning_effort` on these providers. The specialist (adr:0002-run-the-specialist-through-the-pinned-claude-code-cli)
and the sandbox are untouched. Rejected: a dedicated `@langchain/deepseek` client,
which would add a dependency and one more code path for what a base URL already covers.

## Consequences

- OpenRouter's `models` fallback and `provider.data_collection: deny` have no
  equivalent on the other providers: source code goes to that provider under its own
  terms, and the user chooses it knowingly.
- These APIs report tokens but no cost, so the orchestrator's cost for a task is 0
  on them; the specialist's cost is unchanged.
- Models that return a separate reasoning channel and require it to be sent back across
  tool calls (such as `deepseek-reasoner`) are not supported through the plain OpenAI
  client; the DeepSeek preset is `deepseek-chat`.
- A custom base URL may be plain `http` (a local server) but never carries credentials in it.
