# ChatGPT / Codex OAuth provider with token sharing — design

## Overview

The ChatGPT provider enables users with ChatGPT Plus or Pro accounts to authenticate using OpenAI's official open-source token-sharing standard (ADR 0030) and run tasks using their subscription model allowance without a commercial API key.

## Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant App as Harness for REA (Host)
    participant Loopback as Ephemeral Loopback (127.0.0.1)
    participant Browser as User Browser
    participant OpenAI as OpenAI Auth Server
    participant Keychain as OS Keychain

    User->>App: Click "Connect ChatGPT Account"
    App->>App: Generate PKCE (verifier, challenge) + state + nonce + host_id
    App->>Loopback: Start HTTP server on 127.0.0.1:port
    App->>Browser: Open https://auth.openai.com/authorize?client_id=dynamic_agent_client...
    Browser->>OpenAI: User signs in & grants consent
    OpenAI->>Browser: Redirect to 127.0.0.1:port/callback?code=...&state=...
    Browser->>Loopback: GET /callback?code=...&state=...
    Loopback->>App: Return code & verify state
    Loopback->>Browser: Serve 200 OK HTML "Authorization Complete"
    Loopback->>Loopback: Close server
    App->>OpenAI: POST /oauth/token (code + code_verifier + client_id)
    OpenAI->>App: Return access_token, refresh_token, scope
    App->>App: Validate scope (chatgpt.tokens.use.direct)
    App->>Keychain: Save session to chatgpt.key (DPAPI / Keychain)
    App->>User: Display connected status & available models
```

## State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Authorizing: startSignIn()
    Authorizing --> Exchanging: callback received (state matches)
    Authorizing --> Idle: error / cancelled / timeout
    Exchanging --> Connected: token exchange success & scope verified
    Exchanging --> Failed: invalid grant / insufficient scope
    Failed --> Idle: reset
    Connected --> Refreshing: token expired
    Refreshing --> Connected: new access_token acquired
    Refreshing --> Expired: refresh_token rejected
    Expired --> Authorizing: re-authenticate
    Connected --> Idle: signOut() / clearKey()
```

## Component Boundaries

1. `src/main/chatgpt.ts`: Implements `ChatGPTAuthService`, PKCE helpers, loopback server lifecycle, token exchange, token refresh, and scope validation.
2. `src/shared/providers.ts`: Adds `chatgpt` to `PROVIDER_IDS` with preset configuration (`gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini`).
3. `src/main/credentials.ts`: Recognizes `chatgpt` provider key slot `chatgpt.key`.
4. `src/main/orchestrator/model.ts`: Dispatches `chatgpt` requests to OpenAI API with authorized bearer token.
