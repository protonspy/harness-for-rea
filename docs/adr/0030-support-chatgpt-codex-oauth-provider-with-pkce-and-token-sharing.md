---
status: accepted
---

# 0030 · Support ChatGPT / Codex OAuth provider with PKCE and token sharing

## Context

Issue #2 requested investigating and implementing the ability to connect a personal ChatGPT / Codex account using OpenAI's official open-source framework ([Sign in with ChatGPT and Token Sharing for Open Source](https://developers.openai.com/siwc/token-sharing-open-source)), enabling users with eligible ChatGPT Plus or Pro subscriptions to utilize their subscription plan allowance without requiring a separate prepaid API key.

The investigation required addressing architectural boundaries, provider isolation, and sandbox integrity:
1. **Separation from River and Hopper:** A ChatGPT session authorizes access strictly to OpenAI's token-sharing endpoints; it does not authenticate `https://api.river.ai/v1`, does not unlock River models, and does not alter Hopper client attribution or OpenRouter credit routing.
2. **Architecture Choice:** OpenAI documents two paths for client integration:
   - Direct OAuth 2.0 Authorization Code with PKCE and Token Sharing via dynamic client identity (`dynamic_agent_client`) and loopback callback (`127.0.0.1`).
   - `codex-app-server`: An external daemon process (from `openai/codex`) that communicates via JSON-RPC 2.0 to orchestrate turns, threads, and execution environments.
3. **Sandbox and Execution Guarantees:** Harness for REA enforces strict task container isolation (adr:0006, adr:0015, adr:0016), tool gating, unified diff patches, and read-only source roots. Credential material must remain protected in the OS keychain and never leak into task containers or diagnostic logs.
4. **Credential Privacy:** The application must not read, copy, or mutate session tokens from existing local installations of OpenAI Codex (`~/.codex/session.json` or cookies).

## Decision

We adopt **direct OAuth 2.0 Authorization Code with PKCE and Token Sharing** as a distinct, first-class provider (`chatgpt`) in Harness for REA, rejecting `codex-app-server` as an external sidecar.

### Architectural Rationale
- Embedding or supervising `codex-app-server` would introduce a heavy, platform-specific Rust binary dependency and duplicate Harness's existing orchestration layer (LangChain, DeepAgents, MCP tool proxies, IDA Pro / Cheat Engine integrations, and Docker/WSL container execution).
- Direct OAuth 2.0 PKCE integration adheres to OpenAI's open-source token-sharing specification, fits seamlessly into the desktop and TUI runtime, uses Harness's native OpenAI-compatible chat model abstractions (`ChatOpenAI`), and maintains complete control over sandboxing and security policies.

### Protocol Implementation
1. **Official Endpoints:**
   - Authorize: `https://auth.openai.com/api/accounts/authorize`
   - Token: `https://auth.openai.com/api/accounts/oauth/token`
   - Revoke: `https://auth.openai.com/api/accounts/oauth/revoke`
   - Responses API: `https://api.openai.com/v1/responses`
2. **Client Identity & Host ID:** The application initiates registration with `client_id=dynamic_agent_client`, retains any issued `client_id` associated with the account, and persists a random machine identifier (`ext_agent_host_id`) stored in settings to maintain session continuity across launches.
3. **PKCE & State Validation:** Implements RFC 7636 PKCE using S256 (`code_verifier` 43–128 characters, SHA-256 `code_challenge`), along with cryptographically random `state` and `nonce` parameters.
4. **ID Token Cryptographic & Claims Validation:** Validates OpenID Connect ID token signature, issuer (`https://auth.openai.com`), audience (`client_id`), expiration, and `nonce` matching the authorization request, using `sub` as the unique user identity.
5. **Loopback Callback Server:** The host spins up an ephemeral HTTP server on `127.0.0.1` to receive the authorization redirect, serves static sanitized completion HTML without reflecting untrusted query parameters, and validates `state` before triggering code exchange.
6. **Token Management & Storage:** The exchanged `access_token` and `refresh_token` are saved exclusively in the host's protected OS keychain (DPAPI via `safeStorage` in the desktop app, OS keychain in the TUI) under key slot `chatgpt.key`. All token strings are registered in the global secret redactor.
7. **Generational Session Lifecycle:** Monotonically increasing generation counters prevent out-of-order race conditions between token refreshes and logouts. Automatic token refresh handles expiration. The user can disconnect or change accounts at any time, which revokes the active session on the auth server (`token_type_hint=refresh_token`) and clears stored tokens.
8. **Plan & Scope Verification:** Explicitly requests and verifies scopes: `openid`, `profile`, `email`, `offline_access`, `chatgpt.tokens.use.direct`, and `resource.invoke` with `resource=https://api.openai.com/v1`. If an account lacks token-sharing entitlement (e.g. Free plan without Plus/Pro), the system returns clear error diagnostics. Model catalog listings are not assumed to guarantee plan access.
9. **Responses Transport & Streaming:** Model inference and probing for the ChatGPT provider utilize OpenAI's Responses API with `store: false` and `stream: true`, streaming chunks until `response.completed`.
10. **Dynamic Account Catalog & Model Selection (Issue #14):** Models for the ChatGPT provider belong strictly to the connected account's live catalog discovered via `GET /v1/models` using the OAuth bearer token. Static presets and free-form typing ("Another model, by name…") are excluded. Entries are filtered by `visibility: 'list'`, server order is strictly preserved, `display_name` is presented in UI options, and `slug` is persisted and sent to inference. Model readiness and delegation execution enforce catalog validation on the backend, auto-selecting the first available catalog option when an invalid or legacy model is detected, and clearing selections on account disconnect.

### Impact on Roles & Sandboxes
- **Orchestrator:** Can run on ChatGPT models dynamically provided by the connected plan's catalog via bearer token from token sharing.
- **Specialist:** When configured for ChatGPT, the specialist runs as a DeepAgents agent inside the isolated container sandbox. Tool execution remains strictly governed by Harness container policies and MCP proxies.
- **Credential Boundary:** Secrets are kept in the main process memory and OS keychain; only bearer tokens needed for API calls are utilized, with complete event and log redaction.

## Consequences

- ChatGPT / Codex is available as an independent provider option alongside Hopper, OpenRouter, DeepSeek, and custom OpenAI endpoints.
- No credential material is read from third-party app folders (`~/.codex`).
- River AI remains an independent API-key provider as specified in ADR 0029, preventing cross-contamination of models and billing.
- Container sandboxing, patch gating, and REA tool integrations continue to operate without modification.
