---
status: accepted
---

# 0003 · Authenticate the specialist with the user's Claude plan

## Context

The specialist can authenticate with the user's Claude subscription
(`claude auth login --claudeai`), with an Anthropic API key, or through Bedrock,
Vertex or Foundry. The Agent SDK documentation states: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or rate
limits for their products, including agents built on the Claude Agent SDK." This app
is a personal tool run by its author on their own machine with their own account.
Both reference projects already implement the subscription login flow: the app opens
only an Anthropic https URL, accepts the pasted code, and never reads the stored
credential.

## Decision

The specialist authenticates only with the user's own Claude plan login, inside the
app's isolated `CLAUDE_CONFIG_DIR`. `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` are
stripped from the specialist's environment. Rejected: API-key authentication, by the
user's choice; and offering both, which adds a credential path nobody will use.

## Consequences

- The app is for personal use and must not be distributed to other users as is;
  distributing it requires a new ADR adding API-key or cloud-provider authentication.
- Specialist usage counts against the user's plan limits; `total_cost_usd` is shown
  as an estimate, not a charge.
- Rate-limit and auth failures surface as CLI text and are classified by pattern,
  which is brittle across CLI versions.
