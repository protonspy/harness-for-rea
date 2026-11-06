# Tasks: ChatGPT / Codex OAuth provider with token sharing

- [x] Record ADR 0030 evaluating direct OAuth 2.0 PKCE token sharing vs `codex-app-server`.
- [x] Create specs for requirements, design, and protocol sequence.
- [ ] Implement `src/main/chatgpt.ts`:
  - [ ] PKCE generation (`code_verifier`, `code_challenge` S256).
  - [ ] Cryptographic `state`, `nonce`, and persistent `ext_agent_host_id`.
  - [ ] Ephemeral loopback HTTP callback server on `127.0.0.1`.
  - [ ] Authorization URL generator with required scopes (`chatgpt.tokens.use.direct`, `resource.invoke`, `openid`, `profile`, `email`).
  - [ ] Token exchange (`grant_type=authorization_code`) and refresh (`grant_type=refresh_token`).
  - [ ] Token revocation and sign-out.
  - [ ] Secret redaction and error mappings.
  - [ ] Model inference and tool execution validation helper.
- [ ] Wire `chatgpt` into `src/shared/providers.ts`:
  - [ ] Add `"chatgpt"` to `PROVIDER_IDS` and define `PROVIDERS.chatgpt`.
- [ ] Add unit and integration tests in `tests/chatgpt.test.ts`.
- [ ] Run full test suite, typecheck, lint, and build verification.
