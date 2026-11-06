---
autonomy: auto
ci: wait
branch: feat/chatgpt-codex-oauth-provider
delivery: in-review
pr: 13
---

# ChatGPT / Codex OAuth provider with token sharing — requirements

## Purpose

Implement official browser login and token sharing for ChatGPT / Codex as an independent provider option (Issue #2), following OpenAI's official open-source token-sharing framework and architectural decision ADR 0030.

## R1 · Capability detection and OAuth 2.0 PKCE flow

- **R1.1** The system shall implement RFC 7636 PKCE using S256 (`code_verifier` of 43–128 characters, base64url-encoded SHA-256 `code_challenge`).
- **R1.2** The system shall generate and validate a cryptographically secure `state` and `nonce` for every authorization request.
- **R1.3** The authorization request shall use official OpenAI endpoints (`https://auth.openai.com/api/accounts/authorize`, `/api/accounts/oauth/token`, and `/api/accounts/oauth/revoke`), dynamic client identification (`client_id=dynamic_agent_client`), persistent host identifier (`ext_agent_host_id`), and resource parameter (`resource=https://api.openai.com/v1`).
- **R1.4** The system shall listen on a local loopback server (`http://127.0.0.1:<port>/callback`) on an ephemeral port to capture the authorization code, serving static sanitized HTML without reflecting query parameters.
- **R1.5** The system shall verify that returned scopes include `chatgpt.tokens.use.direct`, `offline_access`, and identity scopes (`openid`, `profile`, `email`).
- **R1.6** The system shall cryptographically validate the returned ID token, verifying `iss`, `aud`, `exp`, and matching `nonce`.

## R2 · Credential separation and storage

- **R2.1** ChatGPT credentials shall be strictly separated from River, Hopper, OpenRouter, and custom provider slots.
- **R2.2** The OAuth session (`access_token`, `refresh_token`, `clientId`, and metadata) shall be stored in the host's protected OS keychain (DPAPI/safeStorage in desktop, OS keychain in TUI) under slot `chatgpt.key`.
- **R2.3** The system shall never read, inspect, or copy credentials or session files from existing local Codex installations (`~/.codex/`).
- **R2.4** Tokens and authorization secrets shall be registered in the global secret redactor and masked from application logs, timeline events, and network errors.

## R3 · Session lifecycle management

- **R3.1** The system shall automatically refresh expired access tokens using the stored `refresh_token` and issued `clientId`.
- **R3.2** The system shall employ generational tracking on token refreshes to prevent late responses from restoring a session after logout.
- **R3.3** The user shall be able to log out or switch accounts, cleanly revoking active tokens on the remote server (`token_type_hint=refresh_token`) and removing stored keys from the OS keychain.
- **R3.4** The system shall gracefully handle consent denial (`access_denied`), network timeouts, and loopback server aborts without leaking unhandled promise rejections.

## R4 · Model access and error handling

- **R4.1** The provider shall support standard models: `gpt-4o`, `gpt-4o-mini`, `o1`, and `o3-mini`.
- **R4.2** The system shall not assume model catalog listing proves subscription plan entitlement; it shall handle HTTP 403 / `insufficient_scope` and inform the user if their ChatGPT plan does not support token sharing.
- **R4.3** Rate limits (HTTP 429) and model availability errors (HTTP 404) shall be surfaced with actionable error descriptions.

## R5 · Sandbox and tool execution guarantees

- **R5.1** Tasks configured with the ChatGPT provider shall execute tools and delegations strictly within the isolated task container sandbox, with zero credential exposure inside the container.
- **R5.2** The provider shall utilize OpenAI's Responses API (`https://api.openai.com/v1/responses`) with `store: false` and `stream: true`, parsing Server-Sent Events until `response.completed`.
