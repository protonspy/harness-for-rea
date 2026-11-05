---
status: accepted
---

# 0029 · Require API key for River pending official external authorization

## Context

Issue #1 requested an investigation into whether River AI (`https://api.river.ai/v1`,
`https://docs.river.ai/guides/inference/`) supports a browser-based account sign-in
mechanism similar to Hopper's agent registration (adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent,
`src/main/hopper.ts`), so users can connect their River account without manually copying and
pasting an API key during onboarding.

Consultation of official public documentation (`https://docs.river.ai/guides/inference/` as of
2026-11-04) and the River Console interface indicates:
1. River guides users to generate an API key in the River Console (`https://console.river.ai/keys`)
   and supply it via `Authorization: Bearer <key>` on its OpenAI-compatible inference endpoints.
2. No public documented contract for OAuth 2.0, OpenID Connect (OIDC), RFC 8628 Device Authorization
   Grant (`device_code`), or token-issuing API for external third-party clients was found.
3. Unofficial workarounds — such as DOM automation, scraping session cookies from the web console, or
   fabricating pseudo-OAuth endpoints — violate security boundaries, pose credential-theft risks, and
   violate the project's non-negotiable security criteria.

## Decision

River authentication shall be explicitly documented and treated as an API-key-only provider
until River publishes an official, documented third-party authorization flow.

The application records this as a documented external blocker. The UI and onboarding flow
shall not promise a browser login for River; instead, River is supported via explicit API key
entry. The application provides an official deep link directly to the River Console keys page
(`https://console.river.ai/keys`) where users generate their key.

Any attempt to initiate an automated browser sign-in for River must return a structured
unsupported outcome explaining the external limitation, rather than attempting fragile or
insecure scraping mechanisms.

This ADR establishes the architectural boundary and feasibility outcome. An isolated service
contract and simulated verification test suite (`src/main/river.ts`, `tests/river.test.ts`) are
provided to enforce safe key handling and secret redaction. Full production integration into
orchestrator/specialist provider settings and the OS keychain is scheduled separately for Issue #3.

If River later introduces an official OAuth 2.0 or device authorization contract, this ADR will
be superseded or amended with the official protocol specifications.

## Consequences

- Users connecting to River will supply their River API key, which will be protected in the OS keychain
  (via DPAPI / safeStorage in the desktop app and keychain in the TUI) and redacted from logs once River
  is integrated as a native provider (Issue #3).
- The onboarding and settings flows will not offer a "Sign in with River in browser" button that would
  mislead the user or fail silently; they offer direct key configuration with a link to River's console.
- Zero credential scraping or cookie extraction is attempted, maintaining full adherence to
  least privilege and system security boundaries.
- Future native River provider integration (Issue #3) proceeds cleanly on standard OpenAI-compatible
  chat completions with `Authorization: Bearer <RIVER_API_KEY>`.
