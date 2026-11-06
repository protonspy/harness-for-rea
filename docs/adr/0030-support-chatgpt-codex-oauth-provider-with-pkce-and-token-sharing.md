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
1. **Client Identity & Host ID:** The application uses `client_id=dynamic_agent_client` and generates a persistent, random machine identifier (`ext_agent_host_id`) stored in settings to maintain session continuity across launches.
2. **PKCE & State Validation:** Implements RFC 7636 PKCE using S256 (`code_verifier` 43–128 characters, SHA-256 `code_challenge`), along with cryptographically random `state` and `nonce` parameters.
3. **Loopback Callback Server:** The host spins up an ephemeral HTTP server on `127.0.0.1` to receive the authorization redirect, serves a sanitized completion page to the user's browser, and validates `state` before shutting down.
4. **Token Management & Storage:** The exchanged `access_token` and `refresh_token` are saved exclusively in the host's protected OS keychain (DPAPI via `safeStorage` in the desktop app, OS keychain in the TUI) under key slot `chatgpt.key`.
5. **Session Lifecycle:** Automatic token refresh handles token expiration. The user can disconnect or change accounts at any time, which revokes the active session and clears stored tokens.
6. **Plan & Scope Verification:** Explicitly requests and verifies scopes: `openid`, `profile`, `email`, `chatgpt.tokens.use.direct`, and `resource.invoke`. If an account lacks token-sharing entitlement (e.g. Free plan without Plus/Pro), the system returns clear error diagnostics. Model catalog listings are not assumed to guarantee plan access.

### Impact on Roles & Sandboxes
- **Orchestrator:** Can run on ChatGPT models (e.g. `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`) via `ChatOpenAI` pointing to OpenAI endpoints with the user's authorized bearer token.
- **Specialist:** When configured for ChatGPT, the specialist runs as a DeepAgents agent inside the isolated container sandbox. Tool execution remains strictly governed by Harness container policies and MCP proxies.
- **Credential Boundary:** Secrets are kept in the main process memory and OS keychain; only bearer tokens needed for API calls are utilized, with complete event and log redaction.

## Consequences

- ChatGPT / Codex is available as an independent provider option alongside Hopper, OpenRouter, DeepSeek, and custom OpenAI endpoints.
- No credential material is read from third-party app folders (`~/.codex`).
- River AI remains an independent API-key provider as specified in ADR 0029, preventing cross-contamination of models and billing.
- Container sandboxing, patch gating, and REA tool integrations continue to operate without modification.
