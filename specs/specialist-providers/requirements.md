---
autonomy: auto
ci: wait
branch: feat/specialist-providers
delivery: in-review
pr: 33
---

# Specialist providers — requirements

## Purpose

Let the specialist run on a model from OpenRouter, DeepSeek or any OpenAI-compatible endpoint
instead of Claude Code on the user's Claude plan, as a DeepAgents agent in the app whose every
execution happens in the delegation's sandbox. Decided in
adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent; for the user whose analyses
stall on the Claude plan's safeguard refusals.

## R1 · Choice

- **R1.1** The settings shall offer the specialist's provider as one of the orchestrator's providers, Hopper on its default model by default, or the Claude plan, with a model of that provider.
- **R1.4** The providers shall include Hopper, an OpenAI-compatible provider at `https://api.withhopper.com/v1` whose default model is `deepseek-v4.1-flash-1017-abliterated`, and Hopper shall be the default provider of the orchestrator and of the specialist.
- **R1.5** While the user sets Hopper's key, the settings shall offer the link to create a Hopper account, `https://withhopper.com/cyber`, and say that Harness for REA users get 20% off.
- **R1.2** Where the specialist's provider is one of the orchestrator's providers, the delegation shall run the specialist on that provider's chat model with the provider's key, base URL and the specialist's effort.
- **R1.3** While the specialist's provider is one of the orchestrator's providers, the readiness check shall not require the Claude sign-in and shall require the provider's key where it takes one, its base URL and the specialist's model.

## R2 · Agent

- **R2.1** Where the specialist's provider is one of the orchestrator's providers, the delegation shall run the specialist as a DeepAgents agent in the app's process, with the system prompt and the context package a Claude Code run gets.
- **R2.2** The agent shall run its file tools and its shell inside the delegation's container, and nothing on the host.
- **R2.3** When a delegation on a provider runs without the orchestrator's sandbox, the delegation shall start a container of its own on the workspace's mounts without the Claude login volume, and remove it when the run ends.
- **R2.4** The agent shall reach the MCP servers a Claude Code run gets — ask-user, REA and each offered integration — by starting each in the delegation's container and speaking to it over its standard streams.
- **R2.5** The agent shall name each MCP tool `mcp__<server>__<tool>` and shall offer no tool of DeepAgents' subagents.
- **R2.6** When the agent calls a tool, writes text or answers, the delegation shall record the same events and usage a Claude Code run records.
- **R2.7** If the agent's turn has no model call or tool call for the inactivity timeout, then the delegation shall stop it as timed out.
- **R2.8** If the provider refuses the key or limits the rate, then the delegation shall fail the run naming the provider.

## R3 · Hopper sign-in

- **R3.1** When the user signs in to Hopper with their email, the app shall register with Hopper's agent registration, open its verification page in the browser and show its code.
- **R3.2** While the sign-in waits on the user, the app shall poll Hopper's token endpoint at the interval Hopper gives, and when Hopper returns a key, the app shall store it as Hopper's key in the OS keychain.
- **R3.3** If the code expires, the registration is refused or the user cancels, then the app shall stop polling and say why, storing nothing.
- **R3.4** The app shall open no verification page that is not an `https://withhopper.com` address.

## Out of scope

- A specialist provider or model per project; the choice is the app's.
- Recording a safeguard refusal from a provider model, which declines in its own words.
- Claude Code on a provider model.
