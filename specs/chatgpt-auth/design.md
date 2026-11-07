# ChatGPT / Codex OAuth provider with token sharing — design

## Overview

The ChatGPT provider enables users with ChatGPT Plus or Pro accounts to authenticate using OpenAI's official open-source token-sharing standard (ADR 0030) and run tasks using their subscription model allowance without a commercial API key.

## Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant App as Harness for REA (Host)
    participant Loopback as Ephemeral Loopback (127.0.0.1)
    participant Browser as User Browser
    participant OpenAI as auth.openai.com
    participant Keychain as OS Keychain

    User->>App: Click "Connect ChatGPT Account"
    App->>App: Generate PKCE (verifier, challenge) + state + nonce + host_id
    App->>Loopback: Start HTTP server on 127.0.0.1:port
    App->>Browser: Open https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client...
    Browser->>OpenAI: User signs in & grants consent
    OpenAI->>Browser: Redirect to 127.0.0.1:port/callback?code=...&state=...&client_id=...
    Browser->>Loopback: GET /callback?code=...&state=...
    Loopback->>App: Return code & verify state
    Loopback->>Browser: Serve 200 OK static sanitized HTML
    Loopback->>Loopback: Close server
    App->>OpenAI: POST /api/accounts/oauth/token (code + code_verifier + client_id)
    OpenAI->>App: Return access_token, refresh_token, id_token, client_id, scope
    App->>App: Validate ID token (iss, aud, exp, nonce, sub) & scopes
    App->>App: Register secrets in redactor
    App->>Keychain: Save session to chatgpt.key (DPAPI / Keychain)
    App->>User: Display connected status & available models
```

## State Machine & Generational Coordination

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Authorizing: startSignIn()
    Authorizing --> Exchanging: callback received (state matches)
    Authorizing --> Idle: error / cancelled / timeout
    Exchanging --> Connected: token exchange success, ID token valid & scope verified
    Exchanging --> Failed: invalid grant / insufficient scope / ID token error
    Failed --> Idle: reset
    Connected --> Refreshing: token expired / near expiry
    Refreshing --> Connected: new access_token acquired (gen matches)
    Refreshing --> Expired: refresh_token rejected
    Expired --> Authorizing: re-authenticate
    Connected --> Idle: signOut() -> revokes on auth server & advances generation
```

## Component Boundaries

1. `src/main/chatgpt.ts`: Implements `ChatGPTAuthService`, PKCE helpers, loopback server lifecycle, token exchange, token refresh with generational coordination, ID token validation, and scope verification.
2. `src/shared/providers.ts`: Adds `chatgpt` to `PROVIDER_IDS` with preset configuration (`gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`).
3. `src/shared/api.ts` & `src/main/core.ts`: Wires IPC bridge methods (`startChatGPTAuth`, `chatGPTAuthStatus`, `cancelChatGPTAuth`, `chatGPTLogout`) to the `ChatGPTAuthService` instance in host.
4. `src/main/credentials.ts`: Recognizes `chatgpt` provider key slot `chatgpt.key`.
5. `src/main/orchestrator/model.ts` & `models.ts`: Dispatches `chatgpt` requests to OpenAI Responses API with authorized bearer token.
6. `src/renderer/src/components/setup/panels.tsx`: UI component `ChatGPTOAuthBox` offering seamless one-click connect and disconnect actions.
